from __future__ import annotations

import asyncio
import json
import logging
import math
import os

import httpx
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

# ==== Конфигурация ====

YANDEX_API_KEY = os.getenv("YANDEX_API_KEY", "")
YANDEX_FOLDER_ID = os.getenv("YANDEX_FOLDER_ID", "")

YANDEX_WS_URL = (
    "wss://rest-assistant.api.cloud.yandex.net/v1/realtime/openai"
    f"?model=gpt://{YANDEX_FOLDER_ID}/speech-realtime-250923"
)

YANDEX_REST_BASE = "https://ai.api.cloud.yandex.net/v1"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ==== RAG состояние (in-memory, сбрасывается при рестарте) ====

rag_state: dict[str, str | None] = {
    "vector_store_id": None,
    "file_id": None,
    "filename": None,
}


def yandex_rest_headers() -> dict[str, str]:
    return {
        "Authorization": f"Api-Key {YANDEX_API_KEY}",
        "OpenAI-Project": YANDEX_FOLDER_ID,
    }


# ==== Инструменты агента ====

# Инструменты, выполняемые локально на сервере
LOCAL_TOOLS = {"calculator"}

TOOLS: list[dict] = [
    {
        "type": "function",
        "name": "calculator",
        "description": "Вычисляет математическое выражение. Используй для любых арифметических расчётов.",
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "Математическое выражение, например '2 + 2 * 3' или 'sqrt(144)'",
                }
            },
            "required": ["expression"],
            "additionalProperties": False,
        },
    },
    # Выполняется на стороне Yandex, parameters передаётся строкой "{}"
    {
        "type": "function",
        "name": "web_search",
        "description": "Поиск актуальной информации в интернете. Используй для новостей, текущих событий и любых актуальных данных.",
        "parameters": "{}",
    },
]

SAFE_MATH = {
    "abs": abs, "round": round, "min": min, "max": max, "pow": pow,
    "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "log": math.log, "log10": math.log10, "pi": math.pi, "e": math.e,
}


def execute_tool(name: str, arguments: str) -> str:
    try:
        args = json.loads(arguments) if arguments else {}
    except json.JSONDecodeError:
        args = {}

    if name == "calculator":
        expr = args.get("expression", "")
        try:
            result = eval(expr, {"__builtins__": {}}, SAFE_MATH)  # noqa: S307
            return json.dumps({"result": result}, ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)

    return json.dumps({"error": f"Неизвестный инструмент: {name}"}, ensure_ascii=False)


# ==== Конфигурация сессии ====

BASE_SESSION: dict = {
    "instructions": (
        "Ты — голосовой ассистент-демонстратор возможностей Yandex Realtime API. "
        "Отвечай кратко, дружелюбно и по существу. "
        "У тебя есть инструменты: калькулятор (calculator), поиск в интернете (web_search) "
        "и поиск по загруженным документам (file_search, если активирован). "
        "Используй web_search для новостей, актуальных событий и любой информации, которой у тебя может не быть. "
        "Используй file_search когда пользователь спрашивает о содержимом загруженных документов. "
        "Используй инструменты когда пользователь просит. "
        "ВАЖНО: перед вызовом функции ничего не говори — просто вызови функцию молча. "
        "Ответ формируй только после получения результата функции. "
        "Отвечай на том языке, на котором к тебе обращаются. "
        "Никогда не используй markdown-разметку: никаких **, *, #, -, > и подобных символов — ответы озвучиваются вслух."
    ),
    "modalities": ["text", "audio"],
    "input_audio_format": "pcm16",
    "output_audio_format": "pcm16",
    "turn_detection": {
        "type": "server_vad",
        "threshold": 0.5,
        "silence_duration_ms": 400,
    },
    "voice": "masha",
    "speed": 1.2,
    "tool_choice": "auto",
    "temperature": 0.8,
}


def build_session_config() -> dict:
    """Строит session.update с актуальным набором инструментов (включая file_search если активен)."""
    tools = list(TOOLS)
    if rag_state["vector_store_id"]:
        tools.append({
            "type": "function",
            "name": "file_search",
            # Yandex-native формат: vector_store_id передаётся в description
            "description": rag_state["vector_store_id"],
            "parameters": "{}",
        })
    return {"type": "session.update", "session": {**BASE_SESSION, "tools": tools}}


# ==== FastAPI приложение ====

app = FastAPI(title="Yandex Realtime API Demo")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


# ── RAG: загрузка файла ────────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_rag_file(file: UploadFile = File(...)):
    """Загружает файл в Yandex Files API, создаёт Vector Store, ждёт готовности."""
    if not YANDEX_API_KEY or not YANDEX_FOLDER_ID:
        raise HTTPException(500, "YANDEX_API_KEY or YANDEX_FOLDER_ID not set")

    file_bytes = await file.read()
    headers = yandex_rest_headers()

    async with httpx.AsyncClient(timeout=30) as client:
        # Удаляем предыдущий vector store и файл, если есть
        if rag_state["vector_store_id"]:
            try:
                await client.delete(
                    f"{YANDEX_REST_BASE}/vector_stores/{rag_state['vector_store_id']}",
                    headers=headers,
                )
                logger.info("Deleted old vector store: %s", rag_state["vector_store_id"])
            except Exception as exc:
                logger.warning("Failed to delete old vector store: %s", exc)
            rag_state["vector_store_id"] = None

        if rag_state["file_id"]:
            try:
                await client.delete(
                    f"{YANDEX_REST_BASE}/files/{rag_state['file_id']}",
                    headers=headers,
                )
                logger.info("Deleted old file: %s", rag_state["file_id"])
            except Exception as exc:
                logger.warning("Failed to delete old file: %s", exc)
            rag_state["file_id"] = None

        # Загружаем файл
        resp = await client.post(
            f"{YANDEX_REST_BASE}/files",
            headers=headers,
            files={"file": (file.filename, file_bytes, file.content_type or "application/octet-stream")},
            data={"purpose": "assistants"},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(resp.status_code, f"File upload failed: {resp.text}")

        file_id = resp.json()["id"]
        rag_state["file_id"] = file_id
        rag_state["filename"] = file.filename
        logger.info("Uploaded file: %s -> %s", file.filename, file_id)

        # Создаём Vector Store
        resp = await client.post(
            f"{YANDEX_REST_BASE}/vector_stores",
            headers={**headers, "Content-Type": "application/json"},
            json={"name": file.filename, "file_ids": [file_id]},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(resp.status_code, f"Vector store creation failed: {resp.text}")

        vector_store_id = resp.json()["id"]
        logger.info("Created vector store: %s", vector_store_id)

    # Поллинг до готовности (вынесен в отдельный клиент чтобы не блокировать первый)
    async with httpx.AsyncClient(timeout=15) as client:
        for attempt in range(60):  # максимум 120 секунд
            await asyncio.sleep(2)
            resp = await client.get(
                f"{YANDEX_REST_BASE}/vector_stores/{vector_store_id}",
                headers=headers,
            )
            if resp.status_code not in (200, 201):
                raise HTTPException(resp.status_code, f"Polling failed: {resp.text}")

            status = resp.json().get("status")
            logger.info("Vector store %s status: %s (attempt %d)", vector_store_id, status, attempt + 1)

            if status == "completed":
                break
            if status in ("failed", "expired"):
                raise HTTPException(500, f"Vector store failed with status: {status}")
        else:
            raise HTTPException(504, "Vector store creation timed out after 120s")

    rag_state["vector_store_id"] = vector_store_id
    logger.info("RAG ready: vector_store_id=%s file=%s", vector_store_id, file.filename)

    return {
        "vector_store_id": vector_store_id,
        "filename": file.filename,
        "file_id": file_id,
    }


@app.get("/api/rag/status")
async def rag_status():
    """Возвращает текущее состояние RAG."""
    return {
        "active": rag_state["vector_store_id"] is not None,
        "vector_store_id": rag_state["vector_store_id"],
        "file_id": rag_state["file_id"],
        "filename": rag_state["filename"],
    }


@app.delete("/api/rag/clear")
async def clear_rag():
    """Удаляет vector store и файл из Yandex, сбрасывает состояние."""
    if not rag_state["vector_store_id"] and not rag_state["file_id"]:
        return {"message": "Nothing to clear"}

    headers = yandex_rest_headers()
    async with httpx.AsyncClient(timeout=15) as client:
        if rag_state["vector_store_id"]:
            try:
                await client.delete(
                    f"{YANDEX_REST_BASE}/vector_stores/{rag_state['vector_store_id']}",
                    headers=headers,
                )
            except Exception as exc:
                logger.warning("Failed to delete vector store: %s", exc)

        if rag_state["file_id"]:
            try:
                await client.delete(
                    f"{YANDEX_REST_BASE}/files/{rag_state['file_id']}",
                    headers=headers,
                )
            except Exception as exc:
                logger.warning("Failed to delete file: %s", exc)

    rag_state["vector_store_id"] = None
    rag_state["file_id"] = None
    rag_state["filename"] = None
    logger.info("RAG cleared")
    return {"message": "RAG cleared"}


# ── WebSocket прокси ──────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_proxy(browser_ws: WebSocket):
    await browser_ws.accept()

    if not YANDEX_API_KEY or not YANDEX_FOLDER_ID:
        await browser_ws.send_json(
            {"type": "error", "error": {"message": "YANDEX_API_KEY or YANDEX_FOLDER_ID not set in .env"}}
        )
        await browser_ws.close()
        return

    headers = {"Authorization": f"Api-Key {YANDEX_API_KEY}"}

    try:
        yandex_ws = await websockets.connect(
            YANDEX_WS_URL,
            additional_headers=headers,
            ping_interval=20,
            max_size=10 * 1024 * 1024,  # 10MB — Yandex может слать большие аудио-чанки
        )
    except Exception as exc:
        logger.error("Failed to connect to Yandex: %s", exc)
        await browser_ws.send_json(
            {"type": "error", "error": {"message": f"Yandex connection failed: {exc}"}}
        )
        await browser_ws.close()
        return

    logger.info("Connected to Yandex Realtime API")

    async def browser_to_yandex():
        try:
            while True:
                data = await browser_ws.receive_json()
                await yandex_ws.send(json.dumps(data))
        except WebSocketDisconnect:
            logger.info("Browser disconnected")
        except Exception as exc:
            logger.error("browser_to_yandex error: %s", exc)

    async def yandex_to_browser():
        web_search_timer: asyncio.Task | None = None

        async def _fire_tool_indicator():
            await asyncio.sleep(0.4)
            tool_name = "file_search" if rag_state["vector_store_id"] else "web_search"
            logger.info("Server-side tool detected (no delta after 400ms): %s", tool_name)
            await browser_ws.send_json({
                "type": "tool_call",
                "name": tool_name,
                "arguments": "{}",
                "result": json.dumps({"статус": "выполняется на стороне Yandex"}, ensure_ascii=False),
            })

        try:
            async for raw in yandex_ws:
                msg = json.loads(raw)
                msg_type = msg.get("type", "")

                logger.info("Yandex event: %s", msg_type)

                if msg_type == "session.created":
                    logger.info("Session created, sending config (RAG active: %s)", bool(rag_state["vector_store_id"]))
                    await yandex_ws.send(json.dumps(build_session_config()))

                if msg_type == "response.output_item.added":
                    item = msg.get("item", {})
                    if item.get("type") == "function_call":
                        fn_name = item.get("name", "")
                        if fn_name not in LOCAL_TOOLS:
                            await browser_ws.send_json({
                                "type": "tool_call",
                                "name": fn_name,
                                "arguments": item.get("arguments", "{}"),
                                "result": json.dumps({"статус": "выполняется на стороне Yandex"}, ensure_ascii=False),
                            })
                    elif item.get("type") == "message":
                        # Start timer: if no audio/text delta arrives within 1s,
                        # Yandex is executing a server-side tool (web_search / file_search)
                        if web_search_timer:
                            web_search_timer.cancel()
                        web_search_timer = asyncio.create_task(_fire_tool_indicator())

                if msg_type in (
                    "response.output_audio.delta", "response.output_text.delta",
                    "response.audio.delta", "response.text.delta",
                ):
                    if web_search_timer:
                        web_search_timer.cancel()
                        web_search_timer = None

                if msg_type == "response.output_item.done":
                    item = msg.get("item", {})
                    if item.get("type") == "function_call":
                        fn_name = item.get("name", "")

                        call_id = item.get("call_id")
                        fn_args = item.get("arguments", "{}")
                        logger.info("Tool call: %s(%s)", fn_name, fn_args)

                        result = execute_tool(fn_name, fn_args)
                        logger.info("Tool result: %s", result)

                        await yandex_ws.send(
                            json.dumps({
                                "type": "conversation.item.create",
                                "item": {
                                    "type": "function_call_output",
                                    "call_id": call_id,
                                    "output": result,
                                },
                            })
                        )
                        await yandex_ws.send(json.dumps({"type": "response.create"}))

                        await browser_ws.send_json({
                            "type": "tool_call",
                            "name": fn_name,
                            "arguments": fn_args,
                            "result": result,
                        })
                        continue


                if msg_type == "error":
                    logger.error("Yandex error: %s", json.dumps(msg, ensure_ascii=False))

                await browser_ws.send_json(msg)

        except websockets.exceptions.ConnectionClosed:
            logger.info("Yandex WebSocket closed")
        except Exception as exc:
            logger.error("yandex_to_browser error: %s", exc)

    tasks = [
        asyncio.create_task(browser_to_yandex()),
        asyncio.create_task(yandex_to_browser()),
    ]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except Exception as exc:
        logger.error("Session error: %s", exc)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await yandex_ws.close()
        except Exception:
            pass
        logger.info("Session ended")
