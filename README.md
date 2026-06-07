# Yandex Realtime API Demo

Голосовой ассистент на базе [Yandex AI Studio Realtime API](https://aistudio.yandex.ru/). FastAPI-сервер работает как WebSocket-прокси между браузером и Yandex, добавляя поддержку инструментов и RAG.

## Возможности

- Голосовой диалог в реальном времени (задержка < 500 мс)
- Voice Activity Detection — автоматическое определение конца фразы
- Текстовый ввод как альтернатива голосу
- Инструменты: `calculator` (выполняется на сервере), `web_search` (выполняется на стороне Yandex)
- RAG: загрузка документа → векторный индекс → поиск по содержимому через `search_index`
- Настройки голоса, амплуа, языка распознавания/синтеза, чувствительности VAD и системного промпта прямо из браузера
- Выбор realtime-модели (`speech-realtime-250923` / `speech-realtime-260528`) из панели настроек

## Быстрый старт

### Локально

```bash
# Установить зависимости
uv sync

# Создать .env
echo "YANDEX_API_KEY=your_key" >> .env
echo "YANDEX_FOLDER_ID=your_folder_id" >> .env

# Запустить
uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Открыть http://localhost:8000

> Микрофон работает только через `http://localhost` или HTTPS — ограничение браузера.

### Docker

```bash
docker compose up --build
```

## Переменные окружения

| Переменная | Описание |
|---|---|
| `YANDEX_API_KEY` | API-ключ Yandex Cloud |
| `YANDEX_FOLDER_ID` | ID каталога Yandex Cloud |

## API

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/` | Веб-интерфейс |
| `WS` | `/ws` | WebSocket-прокси к Yandex Realtime API |
| `POST` | `/api/upload` | Загрузить файл для RAG (multipart: `file`, `session_id`; макс. 128 МБ) |
| `DELETE` | `/api/rag/clear` | Удалить файл и векторный индекс (query: `session_id`) |
| `GET` | `/api/health` | Healthcheck |

## Как работает

```
Браузер  ←──WS /ws──→  main.py  ←──WSS──→  Yandex Realtime API
                           │
                    REST /api/upload
                    (Files API + Vector Stores)
```

### WebSocket-прокси

`main.py` — единственный процесс. Эндпоинт `/ws` принимает подключение браузера и открывает встречное соединение к Yandex Realtime API. На каждую сессию запускаются два async task:

- **`browser_to_yandex`** — пересылает все сообщения от браузера (аудио-чанки, текст, настройки) напрямую в Yandex.
- **`yandex_to_browser`** — получает события от Yandex и пересылает их браузеру. Перехватывает `response.output_item.done` с `type: "function_call"`: если инструмент локальный (`calculator`), выполняет его на сервере и отправляет результат обратно в Yandex. Серверные инструменты Yandex (`web_search`, `search_index`) проходят насквозь — Yandex выполняет их сам.

Конфигурацию сессии целиком задаёт браузер — единственный источник правды. Получив `session.created`, он отправляет `session.update` со всеми настройками (инструкции, голос, амплуа, режим ответа, параметры VAD, инструменты, RAG). Сервер свой `session.update` не шлёт, чтобы не конкурировать за состояние сессии. Модель для подключения выбирается в браузере и передаётся серверу query-параметром `?model=` при открытии `/ws`.

### Аудио

Браузер захватывает микрофон через `getUserMedia`, конвертирует PCM-поток в Int16 с помощью `AudioWorkletProcessor` (`pcm-worklet.js`) и стримит чанки по ~100 мс через WebSocket (`input_audio_buffer.append`). Входящий аудио от модели (`response.output_audio.delta`, base64 PCM16) декодируется и ставится в очередь `AudioBufferSourceNode` для воспроизведения.

### RAG

При загрузке файла через `/api/upload`:
1. Файл загружается в Yandex Files API.
2. Создаётся векторный индекс (Vector Store) и поллится до статуса `completed`.
3. Браузер добавляет инструмент `file_search` (с `vector_store_id`) в конфиг сессии и отправляет обновлённый `session.update` в Yandex.
4. Браузер инжектирует сообщение в историю диалога, явно информируя модель о загруженном файле.

Yandex переименовывает `file_search` в `search_index` на своей стороне — именно под этим именем инструмент виден модели. При закрытии сессии сервер автоматически удаляет векторный индекс и файл из Yandex.
