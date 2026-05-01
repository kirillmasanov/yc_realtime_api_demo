# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
uv sync

# Run dev server (with auto-reload)
uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Add a dependency
uv add <package>
```

## Architecture

Single-process FastAPI app acting as a **WebSocket proxy** between the browser and the Yandex Cloud Realtime API.

```
Browser  <──WS /ws──>  main.py  <──WSS──>  Yandex Realtime API
```

**`main.py`** — entire backend. One WebSocket endpoint `/ws` spawns two concurrent async tasks per connection:
- `browser_to_yandex` — forwards raw JSON from browser to Yandex
- `yandex_to_browser` — forwards Yandex events to browser, intercepts `response.output_item.done` events with `type: "function_call"` to execute tools server-side, then sends `function_call_output` + `response.create` back to Yandex

On `session.created` from Yandex, the server immediately sends `session.update` with the agent instructions, modalities, VAD config, voice, and tool definitions.

**Tool execution** (`execute_tool`) runs synchronously on the server. One locally-executed tool: `calculator` (safe `eval` with `SAFE_MATH` namespace). The `web_search` tool has `parameters: "{}"` (a string, not an object) — this is the Yandex-native format; Yandex executes it server-side and it is **not** intercepted by `execute_tool`.

**`static/app.js`** — browser-side logic:
- WebSocket to `/ws` with exponential backoff reconnect
- Toggle-to-talk: click mic button → init `AudioContext(44100Hz)` + `getUserMedia` → start `AudioWorkletNode("pcm-processor")` → stream `input_audio_buffer.append` messages; click again → stop → send `input_audio_buffer.commit`
- Settings panel: voice, VAD threshold/silence, system prompt — sends `session.update` directly from browser on top of the server's defaults (browser settings applied on `session.created`)
- Playback: incoming `response.output_audio.delta` (base64 PCM16) → decoded to `Float32Array` → scheduled `AudioBufferSourceNode` queue; stopped on `input_audio_buffer.speech_started`
- Handles both OpenAI event names (`response.audio.delta`) and Yandex variants (`response.output_audio.delta`) — check both in every switch/case

**`static/pcm-worklet.js`** — `AudioWorkletProcessor` that buffers 4410 Float32 samples (~100ms), converts to Int16 PCM16, posts the buffer to the main thread.

## Key API Details

- **Yandex WS URL:** `wss://rest-assistant.api.cloud.yandex.net/v1/realtime/openai?model=gpt://{FOLDER_ID}/speech-realtime-250923`
- **Auth header:** `Authorization: Api-Key {YANDEX_API_KEY}`
- **Audio:** PCM16, 44100 Hz, mono, base64-encoded in JSON
- **Protocol:** OpenAI Realtime API-compatible — event names may differ (both variants handled)
- **Env vars:** `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` (loaded from `.env` via `python-dotenv`)

## Documentation

Yandex AI Studio Realtime API reference (use when adding/changing event handling, session config, or tools):

- **Client events** (browser/proxy → Yandex): https://aistudio.yandex.ru/docs/ru/ai-studio/clientEvents/ — full list of `session.update`, `input_audio_buffer.*`, `conversation.item.create`, `response.create`, etc.
- **Server events** (Yandex → proxy/browser): https://aistudio.yandex.ru/docs/ru/ai-studio/serverEvents/ — `session.created`, `response.output_audio.delta`, `response.output_item.done`, `error`, etc.
- **Realtime voice agents concept:** https://aistudio.yandex.ru/docs/ru/ai-studio/concepts/agents/realtime.html
- **Realtime API format changes** (Yandex-specific deltas vs OpenAI): https://aistudio.yandex.ru/docs/ru/ai-studio/concepts/agents/realtime-changes.html
- **Guide — voice agent via Realtime API:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/create-voice-agent.html
- **Voice agent with text responses:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/voice-text-agent.html

## RAG / Files / Vector Stores

RAG flow: upload file → create vector store → poll until `status: "completed"` → inject `file_search` tool in `session.update`.

**REST base URL:** `https://ai.api.cloud.yandex.net/v1`

**Auth headers (REST):**
- `Authorization: Api-Key {YANDEX_API_KEY}`
- `x-folder-id: {YANDEX_FOLDER_ID}`

**`file_search` tool format** (Yandex-native, executed server-side — do NOT intercept in `execute_tool`):
```json
{"type": "function", "name": "file_search", "description": "<VECTOR_STORE_ID>", "parameters": "{}"}
```
The `description` field carries the `vector_store_id` (not a human-readable string). Same `parameters: "{}"` string format as `web_search`.

**Server-side tools guard:** `LOCAL_TOOLS = {"calculator"}` — only tools in this set are intercepted in `yandex_to_browser`. All others (including `file_search`, `web_search`) are passed through unmodified.

**App endpoints:**
- `POST /api/upload` — multipart file upload, creates vector store, polls until ready, returns `{vector_store_id, filename, file_id}`
- `GET /api/rag/status` — current RAG state `{active, vector_store_id, file_id, filename}`
- `DELETE /api/rag/clear` — deletes vector store and file from Yandex, resets state

**Files API:**
- **Overview:** https://aistudio.yandex.ru/docs/ru/ai-studio/files/
- **Upload file:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/files-upload.html
- **Upload pre-chunked (JSONL):** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/files-upload-chunks.html

**Vector Stores API:**
- **Overview:** https://aistudio.yandex.ru/docs/ru/ai-studio/vectorStores/
- **Create vector store:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/vectorstore-create.html
- **Search vector store:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/vectorstore-search.html
- **Remove file from store:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/vectorstore-remove-file.html
- **Delete vector store:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/vectorstore-delete.html
- **Manage search index:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/manage-searchindex.html
- **Pre-chunked search agent guide:** https://aistudio.yandex.ru/docs/ru/ai-studio/operations/agents/create-prechunked-search-agent.html
