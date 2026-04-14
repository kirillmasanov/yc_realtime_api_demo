# Yandex Realtime API — FastAPI Web Application

## Context

Нужно создать веб-приложение, демонстрирующее возможности Yandex Cloud Realtime API. Приложение — голосовой чат: пользователь говорит в микрофон, AI-ассистент отвечает голосом и текстом. Это greenfield проект — существует только `.env` и `task.md`.

## Архитектура

```
Browser (Web Audio API)  ←→  FastAPI WebSocket (/ws)  ←→  Yandex Realtime API (wss://)
```

FastAPI выступает прокси между браузером и Yandex Realtime API. Браузер захватывает аудио через AudioWorklet (PCM16, 44100Hz), отправляет по WebSocket на сервер, сервер проксирует в Yandex. Ответ (аудио + текст) идёт обратным путём.

## Структура проекта

```
realtime_api/
  .env                  # уже есть (YANDEX_API_KEY, YANDEX_FOLDER_ID)
  pyproject.toml        # uv проект
  main.py               # FastAPI backend
  static/
    index.html          # SPA — чат-интерфейс
    style.css           # минималистичный светлый дизайн
    app.js              # аудио захват/воспроизведение, WebSocket, чат UI
    pcm-worklet.js      # AudioWorklet для конвертации Float32 → PCM16
```

## Yandex Realtime API — ключевые параметры

- **URL:** `wss://rest-assistant.api.cloud.yandex.net/v1/realtime/openai?model=gpt://{FOLDER_ID}/speech-realtime-250923`
- **Auth:** заголовок `Authorization: Api-Key {API_KEY}`
- **Аудио:** PCM16, 44100 Hz, моно, base64
- **Протокол:** OpenAI-совместимый
- **Voice:** `masha`, speed 1.2

## Порядок реализации

### Шаг 1: Инициализация проекта
- `uv init` + `pyproject.toml`
- Зависимости: `fastapi`, `uvicorn[standard]`, `websockets`, `python-dotenv`

### Шаг 2: Backend (`main.py`)
- Загрузка `.env` через `python-dotenv`
- `GET /` → отдаёт `static/index.html`
- `GET /static/*` → статические файлы
- `WS /ws` — основной WebSocket endpoint:
  1. Принимает соединение от браузера
  2. Открывает WebSocket к Yandex (`websockets.connect`)
  3. После `session.created` отправляет `session.update` с конфигом
  4. Два конкурентных таска: `browser→yandex` и `yandex→browser`
  5. При function_call — выполняет инструмент на сервере

**Демо-инструменты:**
- `calculator` — вычисление математических выражений
- `get_weather` — мок-данные о погоде
- `get_current_time` — текущее время

### Шаг 3: AudioWorklet (`static/pcm-worklet.js`)
- Float32 → Int16 (PCM16), буфер ~100мс

### Шаг 4: Frontend (`static/app.js`)
- WebSocket + reconnect
- Push-to-talk (mousedown/touchstart → запись, mouseup/touchend → commit)
- Воспроизведение аудио через AudioBufferSourceNode
- Обработка всех событий Yandex API
- Chat UI с пузырями сообщений

### Шаг 5: HTML + CSS
- Минималистичный светлый дизайн
- Кнопка микрофона, область чата, статус подключения

## Запуск

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```
