// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Должен совпадать с AUDIO_RATE на сервере и rate в pcm-worklet.
const AUDIO_RATE = 44100;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws = null;
let audioContext = null;
let mediaStream = null;
let workletNode = null;
let sourceNode = null;
let silentGain = null;
let isRecording = false;
let audioInitialized = false;

// Playback scheduling
let playbackTime = 0;
let activeSources = [];

// Chat state
let currentAssistantBubble = null;
let currentAssistantTextEl = null;
let currentAssistantText = "";

// Latency tracking
let lastUserQueryAt = null;
let firstDeltaAt = null;

// Reconnect
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// DOM
const chat = document.getElementById("chat");
const micBtn = document.getElementById("mic-btn");
const micStatus = document.getElementById("mic-status");
const statusEl = document.getElementById("status");
const textInput = document.getElementById("text-input");
const sendBtn = document.getElementById("send-btn");
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const fileStatusEl = document.getElementById("file-status");

// RAG state
let currentVectorStoreId = null;
let currentFilename = null;
let sessionId = null;

// Определения инструментов приходят с сервера в событии app.session_id —
// единственный источник правды (см. TOOLS в main.py).
let serverTools = [];

function buildSessionTools() {
  const tools = [...serverTools];
  if (currentVectorStoreId) {
    tools.push({
      type: "function",
      name: "file_search",
      description: currentVectorStoreId,
      parameters: {},
    });
  }
  return tools;
}

// Settings DOM
const settingsPanel = document.getElementById("settings-panel");
const settingsBtn = document.getElementById("settings-btn");
const settingThreshold = document.getElementById("setting-threshold");
const settingThresholdVal = document.getElementById("threshold-val");
const settingSilence = document.getElementById("setting-silence");
const settingSilenceVal = document.getElementById("silence-val");
const settingInstructions = document.getElementById("setting-instructions");
const settingsApply = document.getElementById("settings-apply");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_INSTRUCTIONS =
  "Ты — голосовой ассистент-демонстратор возможностей Yandex Realtime API. " +
  "Отвечай кратко, дружелюбно и по существу. " +
  "Твои инструменты: " +
  "calculator (математические вычисления); " +
  "web_search (актуальная информация из интернета — новости, события, погода, курсы); " +
  "file_search — поиск по содержимому загруженного пользователем документа. " +
  "Если он есть в твоём списке инструментов, значит документ уже загружен и проиндексирован: " +
  "обязательно вызывай его для любых вопросов о содержимом приложенного файла, не отвечай по памяти. " +
  "Если же его нет в твоём списке — значит файл не загружен, так и сообщи пользователю. " +
  "Используй web_search для новостей, актуальных событий и любой информации, " +
  "которой у тебя может не быть в обучении. " +
  "ВАЖНО: перед вызовом функции ничего не говори — просто вызови функцию молча. " +
  "Ответ формируй только после получения результата функции. " +
  "Отвечай на том языке, на котором к тебе обращаются. " +
  "Никогда не используй markdown-разметку: никаких **, *, #, -, > и подобных символов — ответы озвучиваются вслух.";

settingInstructions.value = DEFAULT_INSTRUCTIONS;

function toggleSettings() {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsBtn.classList.toggle("active", !settingsPanel.hidden);
}

function getSelectedVoice() {
  const selected = document.querySelector('input[name="voice"]:checked');
  return selected ? selected.value : "masha";
}

function getSelectedLang() {
  const selected = document.querySelector('input[name="lang"]:checked');
  return selected ? selected.value : "auto";
}

function getSelectedOutputMode() {
  const selected = document.querySelector('input[name="output-mode"]:checked');
  return selected ? selected.value : "audio";
}

function getSessionSettings() {
  let instructions = settingInstructions.value.trim();
  if (currentVectorStoreId && currentFilename) {
    instructions +=
      `\n\nВАЖНО: файл «${currentFilename}» загружен и проиндексирован. ` +
      "Инструмент file_search ДОСТУПЕН и содержит этот файл. " +
      "Для ЛЮБЫХ вопросов о содержимом этого файла ОБЯЗАТЕЛЬНО вызывай file_search — не отвечай по памяти.";
  }
  const outputMode = getSelectedOutputMode();
  return {
    output_modalities: [outputMode],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: AUDIO_RATE },
        languages: [getSelectedLang()],
        turn_detection: {
          type: "server_vad",
          threshold: parseFloat(settingThreshold.value),
          silence_duration_ms: parseInt(settingSilence.value),
        },
      },
      output: {
        format: { type: "audio/pcm", rate: AUDIO_RATE },
        voice: getSelectedVoice(),
      },
    },
    instructions,
    tools: buildSessionTools(),
    // При активном RAG форсируем search_index — иначе модель часто игнорирует инструмент
    tool_choice: currentVectorStoreId
      ? { type: "function", name: "search_index" }
      : "auto",
  };
}

function applySettings() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "session.update", session: getSessionSettings() }));
}

settingThreshold.addEventListener("input", () => {
  settingThresholdVal.textContent = settingThreshold.value;
});

settingSilence.addEventListener("input", () => {
  settingSilenceVal.textContent = settingSilence.value;
});

settingsBtn.addEventListener("click", toggleSettings);

settingsApply.addEventListener("click", () => {
  applySettings();
  settingsApply.textContent = "Применено ✓";
  setTimeout(() => { settingsApply.textContent = "Применить"; }, 1500);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
function updateStatus(text, connected) {
  statusEl.textContent = text;
  statusEl.className = connected ? "connected" : "";
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL("ws", document.baseURI);
  wsUrl.protocol = protocol;
  ws = new WebSocket(wsUrl.href);

  ws.onopen = () => {
    updateStatus("Подключено", true);
    reconnectAttempts = 0;
    micBtn.disabled = false;
    attachBtn.disabled = false;
    micStatus.textContent = "Нажмите для начала записи";
    // textInput и sendBtn включаются в session.updated — сессия готова принимать сообщения
  };

  ws.onclose = () => {
    updateStatus("Отключено", false);
    micBtn.disabled = true;
    textInput.disabled = true;
    sendBtn.disabled = true;
    attachBtn.disabled = true;
    // Сбрасываем RAG — каждая сессия начинается с чистого листа
    sessionId = null;
    currentVectorStoreId = null;
    currentFilename = null;
    attachBtn.classList.remove("has-file");
    setFileStatus("", "");
    reconnect();
  };

  ws.onerror = () => {
    updateStatus("Ошибка подключения", false);
  };

  ws.onmessage = handleMessage;
}

function reconnect() {
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  setTimeout(connect, delay);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function handleMessage(event) {
  const msg = JSON.parse(event.data);
  const type = msg.type;

  switch (type) {
    case "app.session_id":
      sessionId = msg.session_id;
      serverTools = msg.tools || [];
      break;

    case "session.created":
      updateStatus("Сессия активна", true);
      // Применяем пользовательские настройки поверх серверных defaults
      applySettings();
      break;

    case "session.updated":
      updateStatus("Сессия активна", true);
      textInput.disabled = false;
      sendBtn.disabled = false;
      break;

    // Audio response chunks
    case "response.audio.delta":
    case "response.output_audio.delta":
      enqueueAudio(msg.delta);
      break;

    // Text transcript of assistant response
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta":
    case "response.text.delta":
    case "response.output_text.delta":
      appendAssistantText(msg.delta);
      break;

    // User speech transcription
    case "conversation.item.input_audio_transcription.completed":
      if (msg.transcript) {
        addUserMessage(msg.transcript);
      }
      break;

    // Tool call (custom event from server)
    case "tool_call":
      addToolCallMessage(msg.name, msg.arguments, msg.result);
      break;

    // User started speaking — new turn begins
    case "input_audio_buffer.speech_started":
      finalizeAssistantMessage(); // сбрасываем пузырёк: response.done мог не прийти при прерывании
      if (isRecording) stopPlayback();
      break;

    // Response complete
    case "response.done":
      finalizeAssistantMessage();
      break;

    case "error": {
      const errMsg = msg.error?.message || "Unknown error";
      addSystemMessage("Ошибка: " + errMsg);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Audio capture (push-to-talk)
// ---------------------------------------------------------------------------
async function initAudioContext() {
  if (audioContext) return;
  audioContext = new AudioContext({ sampleRate: AUDIO_RATE });
}

async function initAudio() {
  if (audioInitialized) return;
  await initAudioContext();
  await audioContext.audioWorklet.addModule(new URL("static/pcm-worklet.js", document.baseURI).href);
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: AUDIO_RATE,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  audioInitialized = true;
}

async function startRecording() {
  if (isRecording) return;
  if (audioContext && audioContext.state === "suspended") {
    await audioContext.resume();
  }

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

  workletNode.port.onmessage = (event) => {
    if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
    const base64 = arrayBufferToBase64(event.data);
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
  };

  // Connect worklet through silent gain so it processes audio
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  isRecording = true;
  micBtn.classList.add("recording");
  micStatus.textContent = "Говорите...";
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }

  // Commit audio buffer
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  micBtn.classList.remove("recording");
  micStatus.textContent = "Нажмите для начала записи";
}

// ---------------------------------------------------------------------------
// Audio playback
// ---------------------------------------------------------------------------
async function enqueueAudio(base64Delta) {
  if (!audioContext) return;
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const arrayBuffer = base64ToArrayBuffer(base64Delta);
  const int16Array = new Int16Array(arrayBuffer);
  const float32Array = new Float32Array(int16Array.length);

  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 0x8000;
  }

  const audioBuffer = audioContext.createBuffer(1, float32Array.length, AUDIO_RATE);
  audioBuffer.getChannelData(0).set(float32Array);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  const now = audioContext.currentTime;
  if (playbackTime < now) playbackTime = now;
  source.start(playbackTime);
  playbackTime += audioBuffer.duration;

  activeSources.push(source);
  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx !== -1) activeSources.splice(idx, 1);
  };
}

function stopPlayback() {
  for (const src of activeSources) {
    try {
      src.stop();
    } catch {}
  }
  activeSources = [];
  playbackTime = 0;
}

// ---------------------------------------------------------------------------
// Chat UI
// ---------------------------------------------------------------------------
function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "message user";
  div.textContent = text;
  chat.appendChild(div);
  scrollToBottom();
  lastUserQueryAt = performance.now();
  firstDeltaAt = null;
}

function appendAssistantText(delta) {
  if (!currentAssistantBubble) {
    currentAssistantBubble = document.createElement("div");
    currentAssistantBubble.className = "message assistant";
    currentAssistantTextEl = document.createElement("span");
    currentAssistantTextEl.className = "message-text";
    currentAssistantBubble.appendChild(currentAssistantTextEl);
    chat.appendChild(currentAssistantBubble);
    if (lastUserQueryAt !== null && firstDeltaAt === null) {
      firstDeltaAt = performance.now();
    }
  }
  currentAssistantText += delta;
  currentAssistantTextEl.textContent = currentAssistantText;
  scrollToBottom();
}

function finalizeAssistantMessage() {
  // Если пузырька нет — это был только function_call без текста.
  // Сохраняем lastUserQueryAt, чтобы измерить latency финального ответа после тула.
  if (!currentAssistantBubble) return;

  if (lastUserQueryAt !== null && firstDeltaAt !== null) {
    const ttfr = Math.round(firstDeltaAt - lastUserQueryAt);
    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = `${ttfr} мс`;
    currentAssistantBubble.appendChild(meta);
  }
  currentAssistantBubble = null;
  currentAssistantTextEl = null;
  currentAssistantText = "";
  lastUserQueryAt = null;
  firstDeltaAt = null;
}

function addToolCallMessage(name, args, result) {
  const div = document.createElement("div");
  div.className = "message tool";

  let parsedArgs, parsedResult;
  try { parsedArgs = JSON.stringify(JSON.parse(args), null, 2); } catch { parsedArgs = args; }
  try { parsedResult = JSON.stringify(JSON.parse(result), null, 2); } catch { parsedResult = result; }

  div.innerHTML =
    `<div class="tool-header">${escapeHtml(name)}</div>` +
    `<pre class="tool-args">${escapeHtml(parsedArgs)}</pre>` +
    `<pre class="tool-result">${escapeHtml(parsedResult)}</pre>`;
  chat.appendChild(div);
  scrollToBottom();
}


function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "message system";
  div.textContent = text;
  chat.appendChild(div);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Toggle-to-talk event handlers
// ---------------------------------------------------------------------------
async function handleMicToggle(e) {
  e.preventDefault();
  if (!isRecording) {
    try {
      await initAudio();
      await startRecording();
    } catch (err) {
      addSystemMessage("Не удалось получить доступ к микрофону: " + err.message);
    }
  } else {
    stopRecording();
  }
}

micBtn.addEventListener("click", handleMicToggle);

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------
async function sendTextMessage() {
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  textInput.value = "";

  // Init AudioContext for playback (requires user gesture — button click satisfies it)
  await initAudioContext();

  addUserMessage(text);

  ws.send(JSON.stringify({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  }));
  ws.send(JSON.stringify({ type: "response.create" }));
}

sendBtn.addEventListener("click", sendTextMessage);

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});

// ---------------------------------------------------------------------------
// RAG — загрузка файла
// ---------------------------------------------------------------------------
function setFileStatus(text, state) {
  fileStatusEl.textContent = text;
  fileStatusEl.className = state;
  fileStatusEl.hidden = !text;
}

async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  fileInput.value = "";

  setFileStatus(`Загрузка ${file.name}…`, "loading");
  attachBtn.disabled = true;
  attachBtn.classList.remove("has-file");

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("session_id", sessionId);

    const resp = await fetch("api/upload", { method: "POST", body: formData });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || "Ошибка загрузки");
    }

    const data = await resp.json();
    currentVectorStoreId = data.vector_store_id;
    currentFilename = data.filename;

    // Обновляем конфиг сессии: tools + instructions с упоминанием файла
    applySettings();

    // Инжектируем факт загрузки прямо в историю диалога, чтобы модель
    // гарантированно "видела" файл в своём контексте, не полагаясь только
    // на session.update
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `[Системный контекст: файл «${data.filename}» загружен и проиндексирован. Инструмент search_index ДОСТУПЕН. ОБЯЗАТЕЛЬНО вызывай search_index для любых вопросов об этом файле — отвечать без вызова инструмента ЗАПРЕЩЕНО.]`,
          }],
        },
      }));
    }

    setFileStatus(`✓ ${data.filename}`, "ready");
    attachBtn.classList.add("has-file");
    addSystemMessage(`RAG активирован: «${data.filename}». Задавайте вопросы по документу.`);
  } catch (err) {
    setFileStatus(`Ошибка: ${err.message}`, "error");
    currentVectorStoreId = null;
    currentFilename = null;
  } finally {
    attachBtn.disabled = false;
  }
}

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", handleFileUpload);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
connect();
