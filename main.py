from __future__ import annotations

import asyncio
import json
import logging
import math
import os

import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

# ==== Конфигурация ====

YANDEX_API_KEY = os.getenv("YANDEX_API_KEY", "")
YANDEX_FOLDER_ID = os.getenv("YANDEX_FOLDER_ID", "")

# Адрес Yandex Realtime API
YANDEX_WS_URL = (
    "wss://rest-assistant.api.cloud.yandex.net/v1/realtime/openai"
    f"?model=gpt://{YANDEX_FOLDER_ID}/speech-realtime-250923"
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ==== Инструменты агента ====

# Конфигурация инструментов для использования в агенте
TOOLS = [
    # Функция модели для демонстрации работы с вызовом функций
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
    # Инструмент веб-поиска — выполняется на стороне сервера Yandex.
    # parameters передаётся строкой "{}" согласно документации.
    {
        "type": "function",
        "name": "web_search",
        "description": "Поиск актуальной информации в интернете. Используй для новостей, текущих событий и любых актуальных данных.",
        "parameters": "{}",
    },
]

# Безопасное математическое окружение для eval
SAFE_MATH = {
    "abs": abs,
    "round": round,
    "min": min,
    "max": max,
    "pow": pow,
    "sqrt": math.sqrt,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "log": math.log,
    "log10": math.log10,
    "pi": math.pi,
    "e": math.e,
}


# Выполняет вызов инструмента и возвращает результат в виде JSON-строки
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

# Отправляется в Yandex сразу после события session.created
SESSION_CONFIG = {
    "type": "session.update",
    "session": {
        "instructions": (
            "Ты — голосовой ассистент-демонстратор возможностей Yandex Realtime API. "
            "Отвечай кратко, дружелюбно и по существу. "
            "У тебя есть инструменты: калькулятор (calculator) и поиск в интернете (web_search). "
            "Используй web_search для новостей, актуальных событий и любой информации, которой у тебя может не быть. "
            "Используй инструменты когда пользователь просит. "
            "ВАЖНО: перед вызовом функции ничего не говори — просто вызови функцию молча. "
            "Ответ формируй только после получения результата функции. "
            "Отвечай на том языке, на котором к тебе обращаются. "
            "Никогда не используй markdown-разметку: никаких **, *, #, -, > и подобных символов — ответы озвучиваются вслух."
        ),
        "modalities": ["text", "audio"],
        # Формат входящего и исходящего аудио
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm16",
        # Конфигурация серверного VAD
        "turn_detection": {
            "type": "server_vad",  # включаем серверный VAD
            "threshold": 0.5,  # чувствительность
            "silence_duration_ms": 400,  # длительность тишины для завершения речи
        },
        "voice": "masha",  # голос ассистента
        "speed": 1.2,  # скорость речи
        # Инструменты для использования в агенте
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0.8,
    },
}

# ==== FastAPI приложение ====

app = FastAPI(title="Yandex Realtime API Demo")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")


# WebSocket-прокси между браузером и Yandex Realtime API
@app.websocket("/ws")
async def websocket_proxy(browser_ws: WebSocket):
    await browser_ws.accept()

    # Проверяем, что заданы ключ и ID каталога
    if not YANDEX_API_KEY or not YANDEX_FOLDER_ID:
        await browser_ws.send_json(
            {"type": "error", "error": {"message": "YANDEX_API_KEY or YANDEX_FOLDER_ID not set in .env"}}
        )
        await browser_ws.close()
        return

    headers = {"Authorization": f"Api-Key {YANDEX_API_KEY}"}

    # Устанавливаем соединение с Yandex Realtime API
    try:
        yandex_ws = await websockets.connect(
            YANDEX_WS_URL,
            additional_headers=headers,
            ping_interval=20,
        )
    except Exception as exc:
        logger.error("Failed to connect to Yandex: %s", exc)
        await browser_ws.send_json(
            {"type": "error", "error": {"message": f"Yandex connection failed: {exc}"}}
        )
        await browser_ws.close()
        return

    logger.info("Connected to Yandex Realtime API")

    # Передача сообщений от браузера в Yandex
    async def browser_to_yandex():
        try:
            while True:
                data = await browser_ws.receive_json()
                await yandex_ws.send(json.dumps(data))
        except WebSocketDisconnect:
            logger.info("Browser disconnected")
        except Exception as exc:
            logger.error("browser_to_yandex error: %s", exc)

    # Приём и обработка сообщений от Yandex
    async def yandex_to_browser():
        try:
            async for raw in yandex_ws:
                msg = json.loads(raw)
                msg_type = msg.get("type", "")

                # Настройка сессии после подключения
                if msg_type == "session.created":
                    logger.info("Session created, sending config")
                    await yandex_ws.send(json.dumps(SESSION_CONFIG))

                # Завершение вызова функции
                if msg_type == "response.output_item.done":
                    item = msg.get("item", {})
                    if item.get("type") == "function_call":
                        call_id = item.get("call_id")
                        fn_name = item.get("name", "")
                        fn_args = item.get("arguments", "{}")
                        logger.info("Tool call: %s(%s)", fn_name, fn_args)

                        result = execute_tool(fn_name, fn_args)
                        logger.info("Tool result: %s", result)

                        # Возвращаем результат функции в диалог
                        await yandex_ws.send(
                            json.dumps(
                                {
                                    "type": "conversation.item.create",
                                    "item": {
                                        "type": "function_call_output",
                                        "call_id": call_id,
                                        "output": result,
                                    },
                                }
                            )
                        )
                        # Запрашиваем новый ответ агента
                        await yandex_ws.send(json.dumps({"type": "response.create"}))

                        # Уведомляем браузер о вызове инструмента
                        await browser_ws.send_json(
                            {
                                "type": "tool_call",
                                "name": fn_name,
                                "arguments": fn_args,
                                "result": result,
                            }
                        )
                        continue

                # Обработка ошибок
                if msg_type == "error":
                    logger.error("Yandex error: %s", json.dumps(msg, ensure_ascii=False))

                await browser_ws.send_json(msg)

        except websockets.exceptions.ConnectionClosed:
            logger.info("Yandex WebSocket closed")
        except Exception as exc:
            logger.error("yandex_to_browser error: %s", exc)

    try:
        await asyncio.gather(browser_to_yandex(), yandex_to_browser())
    except Exception:
        pass
    finally:
        try:
            await yandex_ws.close()
        except Exception:
            pass
        logger.info("Session ended")
