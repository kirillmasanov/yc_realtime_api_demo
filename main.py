from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import uuid

import httpx
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

# ==== Конфигурация ====

YANDEX_API_KEY = os.getenv("YANDEX_API_KEY", "")
YANDEX_FOLDER_ID = os.getenv("YANDEX_FOLDER_ID", "")

# Доступные realtime-модели. Модель выбирается в браузере и приходит
# query-параметром при подключении к /ws (зашита в URL соединения с Yandex,
# поэтому смена модели = переподключение).
REALTIME_MODELS = {"speech-realtime-250923", "speech-realtime-260528"}
DEFAULT_MODEL = "speech-realtime-250923"


def yandex_ws_url(model: str) -> str:
    return (
        "wss://ai.api.cloud.yandex.net/v1/realtime"
        f"?model=gpt://{YANDEX_FOLDER_ID}/{model}"
    )

# Sample rate для PCM16 аудио — должен совпадать с AudioContext браузера.
AUDIO_RATE = 44100

YANDEX_REST_BASE = "https://ai.api.cloud.yandex.net/v1"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ==== Per-session RAG state ====

# session_id → {vector_store_id, file_id, filename}
sessions: dict[str, dict[str, str | None]] = {}


def _empty_rag() -> dict[str, str | None]:
    return {"vector_store_id": None, "file_id": None, "filename": None}


async def _delete_rag(rag: dict) -> None:
    """Удаляет vector store и файл из Yandex для завершённой сессии."""
    if not rag.get("vector_store_id") and not rag.get("file_id"):
        return
    headers = yandex_rest_headers()
    async with httpx.AsyncClient(timeout=10) as client:
        if rag.get("vector_store_id"):
            try:
                await client.delete(
                    f"{YANDEX_REST_BASE}/vector_stores/{rag['vector_store_id']}",
                    headers=headers,
                )
                logger.info("Deleted vector store: %s", rag["vector_store_id"])
            except Exception as exc:
                logger.warning("Failed to delete vector store: %s", exc)
        if rag.get("file_id"):
            try:
                await client.delete(
                    f"{YANDEX_REST_BASE}/files/{rag['file_id']}",
                    headers=headers,
                )
                logger.info("Deleted file: %s", rag["file_id"])
            except Exception as exc:
                logger.warning("Failed to delete file: %s", exc)


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
    # Выполняется на стороне Yandex
    {
        "type": "function",
        "name": "web_search",
        "description": "Поиск актуальной информации в интернете. Используй для новостей, текущих событий и любых актуальных данных.",
        "parameters": {},
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
        "Твои инструменты: "
        "calculator (математические вычисления); "
        "web_search (актуальная информация из интернета — новости, события, погода, курсы); "
        "file_search — поиск по содержимому загруженного пользователем документа. "
        "Если он есть в твоём списке инструментов, значит документ уже загружен и проиндексирован: "
        "обязательно вызывай его для любых вопросов о содержимом приложенного файла, не отвечай по памяти. "
        "Если же его нет в твоём списке — значит файл не загружен, так и сообщи пользователю. "
        "Используй web_search для новостей, актуальных событий и любой информации, "
        "которой у тебя может не быть в обучении. "
        "ВАЖНО: перед вызовом функции ничего не говори — просто вызови функцию молча. "
        "Ответ формируй только после получения результата функции. "
        "Отвечай на том языке, на котором к тебе обращаются. "
        "Никогда не используй markdown-разметку: никаких **, *, #, -, > и подобных символов — ответы озвучиваются вслух."
    ),
    "output_modalities": ["audio"],
    "audio": {
        "input": {
            "format": {"type": "audio/pcm", "rate": AUDIO_RATE},
            "languages": ["ru-RU"],
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "silence_duration_ms": 1000,
            },
        },
        "output": {
            "format": {"type": "audio/pcm", "rate": AUDIO_RATE},
            "voice": "masha",
        },
    },
    "tool_choice": "auto",
}


def build_session_config(rag: dict) -> dict:
    """Строит session.update с актуальным набором инструментов для данной сессии."""
    tools = list(TOOLS)
    extra: dict = {}
    if rag["vector_store_id"]:
        tools.append({
            "type": "function",
            "name": "file_search",
            # Yandex-native формат: vector_store_id передаётся в description
            "description": rag["vector_store_id"],
            "parameters": {},
        })
        extra["instructions"] = (
            BASE_SESSION["instructions"]
            + f"\n\nФАЙЛ ЗАГРУЖЕН: «{rag['filename']}» проиндексирован и доступен через инструмент file_search. "
            "СТРОГОЕ ПРАВИЛО: на любой вопрос о содержимом этого файла ты ОБЯЗАН сначала вызвать file_search, и только потом отвечать. "
            "Отвечать без вызова file_search ЗАПРЕЩЕНО — даже если кажется, что знаешь ответ. "
            "Фраза «не удаётся получить информацию» недопустима — просто вызови file_search и используй результат."
        )
        # Форсируем вызов search_index при активном RAG —
        # модель в "auto" режиме часто игнорирует инструмент.
        extra["tool_choice"] = {"type": "function", "name": "search_index"}
    return {"type": "session.update", "session": {**BASE_SESSION, **extra, "tools": tools}}


# ==== FastAPI приложение ====

app = FastAPI(title="Yandex Realtime API Demo")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root(request: Request):
    root_path = request.scope.get("root_path", "").rstrip("/")
    with open("static/index.html", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("<head>", f'<head>\n  <base href="{root_path}/">', 1)
    return HTMLResponse(html)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# ── RAG: загрузка файла ────────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_rag_file(file: UploadFile = File(...), session_id: str = Form(...)):
    """Загружает файл в Yandex Files API, создаёт Vector Store, ждёт готовности."""
    if not YANDEX_API_KEY or not YANDEX_FOLDER_ID:
        raise HTTPException(500, "YANDEX_API_KEY or YANDEX_FOLDER_ID not set")

    rag = sessions.get(session_id)
    if rag is None:
        raise HTTPException(400, "Unknown session_id")

    file_bytes = await file.read()
    headers = yandex_rest_headers()

    async with httpx.AsyncClient(timeout=30) as client:
        # Удаляем предыдущий vector store и файл этой сессии, если есть
        if rag["vector_store_id"]:
            try:
                await client.delete(
                    f"{YANDEX_REST_BASE}/vector_stores/{rag['vector_store_id']}",
                    headers=headers,
                )
                logger.info("Deleted old vector store: %s", rag["vector_store_id"])
            except Exception as exc:
                logger.warning("Failed to delete old vector store: %s", exc)
            rag["vector_store_id"] = None

        if rag["file_id"]:
            try:
                await client.delete(
                    f"{YANDEX_REST_BASE}/files/{rag['file_id']}",
                    headers=headers,
                )
                logger.info("Deleted old file: %s", rag["file_id"])
            except Exception as exc:
                logger.warning("Failed to delete old file: %s", exc)
            rag["file_id"] = None

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
        rag["file_id"] = file_id
        rag["filename"] = file.filename
        logger.info("Uploaded file: %s -> %s", file.filename, file_id)

        # Создаём Vector Store
        resp = await client.post(
            f"{YANDEX_REST_BASE}/vector_stores",
            headers={**headers, "Content-Type": "application/json"},
            json={
                "name": file.filename,
                "description": f"Содержимое файла «{file.filename}», загруженного пользователем.",
                "file_ids": [file_id],
                "expires_after": {"anchor": "last_active_at", "days": 1},
            },
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(resp.status_code, f"Vector store creation failed: {resp.text}")

        vector_store_id = resp.json()["id"]
        logger.info("Created vector store: %s", vector_store_id)

    # Поллинг до готовности
    async with httpx.AsyncClient(timeout=15) as client:
        for attempt in range(300):  # максимум 600 секунд (10 минут)
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
            raise HTTPException(504, "Vector store creation timed out after 600s")

    rag["vector_store_id"] = vector_store_id
    logger.info("RAG ready: session=%s vector_store_id=%s file=%s", session_id, vector_store_id, file.filename)

    return {
        "vector_store_id": vector_store_id,
        "filename": file.filename,
        "file_id": file_id,
    }


@app.delete("/api/rag/clear")
async def clear_rag(session_id: str):
    """Удаляет vector store и файл из Yandex для данной сессии."""
    rag = sessions.get(session_id)
    if not rag or (not rag["vector_store_id"] and not rag["file_id"]):
        return {"message": "Nothing to clear"}
    await _delete_rag(rag)
    rag.update({"vector_store_id": None, "file_id": None, "filename": None})
    logger.info("RAG cleared for session %s", session_id)
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

    # Модель выбирается в браузере и приходит query-параметром.
    model = browser_ws.query_params.get("model", DEFAULT_MODEL)
    if model not in REALTIME_MODELS:
        logger.warning("Unknown model %r requested, falling back to %s", model, DEFAULT_MODEL)
        model = DEFAULT_MODEL

    # Создаём per-session RAG state
    session_id = str(uuid.uuid4())
    session_rag = _empty_rag()
    sessions[session_id] = session_rag

    # Отправляем session_id и определения инструментов браузеру.
    # Браузер использует TOOLS как единственный источник правды
    # при построении session.update (без дублирования описаний).
    await browser_ws.send_json({
        "type": "app.session_id",
        "session_id": session_id,
        "tools": TOOLS,
    })

    headers = {"Authorization": f"Api-Key {YANDEX_API_KEY}"}

    try:
        yandex_ws = await websockets.connect(
            yandex_ws_url(model),
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
        sessions.pop(session_id, None)
        return

    logger.info("Connected to Yandex Realtime API (session=%s, model=%s)", session_id, model)

    async def browser_to_yandex():
        try:
            while True:
                data = await browser_ws.receive_json()
                if data.get("type") == "session.update":
                    sess = data.get("session", {})
                    tools = sess.get("tools", "—")
                    tool_names = [t.get("name") for t in tools] if isinstance(tools, list) else tools
                    audio_out = (sess.get("audio") or {}).get("output") or {}
                    logger.info("session.update → Yandex, voice=%s, role=%s, tools=%s, tool_choice=%s",
                                audio_out.get("voice", "—"), audio_out.get("role", "—"),
                                tool_names, sess.get("tool_choice", "—"))
                await yandex_ws.send(json.dumps(data))
        except WebSocketDisconnect:
            logger.info("Browser disconnected (session=%s)", session_id)
        except Exception as exc:
            logger.error("browser_to_yandex error: %s", exc)

    async def yandex_to_browser():
        try:
            async for raw in yandex_ws:
                msg = json.loads(raw)
                msg_type = msg.get("type", "")

                logger.info("Yandex event: %s", msg_type)

                if msg_type == "session.updated":
                    sess = msg.get("session", {})
                    tools = sess.get("tools", [])
                    if isinstance(tools, list):
                        names = []
                        for t in tools:
                            n = t.get("name") or (t.get("function") or {}).get("name")
                            names.append(n)
                        logger.info("  → Yandex session tools=%s, tool_choice=%s",
                                    names, sess.get("tool_choice", "—"))

                if msg_type == "session.created":
                    logger.info("Session created, sending config (RAG active: %s)", bool(session_rag["vector_store_id"]))
                    await yandex_ws.send(json.dumps(build_session_config(session_rag)))

                if msg_type == "conversation.item.input_audio_transcription.completed":
                    logger.info("USER said: %r", msg.get("transcript", ""))

                if msg_type == "response.created":
                    logger.info("response.created id=%s", msg.get("response", {}).get("id"))

                if msg_type == "response.output_audio_transcript.done":
                    logger.info("ASSISTANT said [resp=%s]: %r",
                                msg.get("response_id", "?"), msg.get("transcript", ""))

                if msg_type == "response.done":
                    resp = msg.get("response", {})
                    usage = resp.get("usage", {})
                    in_det = usage.get("input_token_details", {})
                    out_det = usage.get("output_token_details", {})
                    logger.info(
                        "response.done id=%s status=%s | "
                        "input=%s (text=%s cached=%s) output=%s (text=%s audio=%s) total=%s",
                        resp.get("id"), resp.get("status"),
                        usage.get("input_tokens"),
                        in_det.get("text_tokens"), in_det.get("cached_tokens"),
                        usage.get("output_tokens"),
                        out_det.get("text_tokens"), out_det.get("audio_tokens"),
                        usage.get("total_tokens"),
                    )

                if msg_type == "response.output_item.done":
                    item = msg.get("item", {})
                    if item.get("type") == "function_call" and item.get("name", "") in LOCAL_TOOLS:
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
            logger.info("Yandex WebSocket closed (session=%s)", session_id)
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
        # Удаляем сессию и чистим RAG-ресурсы на Yandex
        sessions.pop(session_id, None)
        await _delete_rag(session_rag)
        logger.info("Session ended (session=%s)", session_id)
