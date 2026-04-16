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
let currentAssistantText = "";

// Reconnect
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// DOM
const chat = document.getElementById("chat");
const micBtn = document.getElementById("mic-btn");
const micStatus = document.getElementById("mic-status");
const statusEl = document.getElementById("status");

// Settings DOM
const settingsPanel = document.getElementById("settings-panel");
const settingsBtn = document.getElementById("settings-btn");
const settingVoice = document.getElementById("setting-voice");
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
  "У тебя есть инструменты: калькулятор (calculator) и поиск в интернете (web_search). " +
  "Используй web_search для новостей, актуальных событий и любой информации, которой у тебя может не быть. " +
  "Используй инструменты когда пользователь просит. " +
  "ВАЖНО: перед вызовом функции ничего не говори — просто вызови функцию молча. " +
  "Ответ формируй только после получения результата функции. " +
  "Отвечай на том языке, на котором к тебе обращаются. " +
  "Никогда не используй markdown-разметку: никаких **, *, #, -, > и подобных символов — ответы озвучиваются вслух.";

settingInstructions.value = DEFAULT_INSTRUCTIONS;

function toggleSettings() {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsBtn.classList.toggle("active", !settingsPanel.hidden);
}

function getSessionSettings() {
  return {
    voice: settingVoice.value,
    turn_detection: {
      type: "server_vad",
      threshold: parseFloat(settingThreshold.value),
      silence_duration_ms: parseInt(settingSilence.value),
    },
    instructions: settingInstructions.value.trim(),
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
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    updateStatus("Подключено", true);
    reconnectAttempts = 0;
    micBtn.disabled = false;
    micStatus.textContent = "Нажмите для начала записи";
  };

  ws.onclose = () => {
    updateStatus("Отключено", false);
    micBtn.disabled = true;
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
    case "session.created":
      updateStatus("Сессия активна", true);
      // Применяем пользовательские настройки поверх серверных defaults
      applySettings();
      break;

    case "session.updated":
      updateStatus("Сессия активна", true);
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
async function initAudio() {
  if (audioInitialized) return;

  audioContext = new AudioContext({ sampleRate: 44100 });
  await audioContext.audioWorklet.addModule("/static/pcm-worklet.js");

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 44100,
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

  const audioBuffer = audioContext.createBuffer(1, float32Array.length, 44100);
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
}

function appendAssistantText(delta) {
  if (!currentAssistantBubble) {
    currentAssistantBubble = document.createElement("div");
    currentAssistantBubble.className = "message assistant";
    chat.appendChild(currentAssistantBubble);
  }
  currentAssistantText += delta;
  currentAssistantBubble.textContent = currentAssistantText;
  scrollToBottom();
}

function finalizeAssistantMessage() {
  currentAssistantBubble = null;
  currentAssistantText = "";
}

function addToolCallMessage(name, args, result) {
  const div = document.createElement("div");
  div.className = "message tool";

  let parsedArgs, parsedResult;
  try {
    parsedArgs = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    parsedArgs = args;
  }
  try {
    parsedResult = JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    parsedResult = result;
  }

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
      startRecording();
    } catch (err) {
      addSystemMessage("Не удалось получить доступ к микрофону: " + err.message);
    }
  } else {
    stopRecording();
  }
}

micBtn.addEventListener("click", handleMicToggle);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
connect();
