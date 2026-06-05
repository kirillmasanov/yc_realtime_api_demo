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
let sentAudioSinceStart = false; // были ли отправлены аудио-чанки в текущей записи

// Playback scheduling
let playbackTime = 0;
let activeSources = [];

// Chat state
let currentAssistantBubble = null;
let currentAssistantTextEl = null;
let currentAssistantText = "";
let currentUserBubble = null;
let currentUserItemId = null;
let currentItemRawText = "";     // full raw transcript from Yandex for the current item
let lastCompletedFullText = "";  // full raw transcript of the last completed item

// Latency tracking
let lastUserQueryAt = null;
let firstDeltaAt = null;

// Reconnect
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// Модель, с которой установлено текущее соединение (зашита в URL соединения).
let connectedModel = null;

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
const settingsModal = document.getElementById("settings-modal");
const settingsBtn = document.getElementById("settings-btn");
const settingsClose = document.getElementById("settings-close");
const settingThreshold = document.getElementById("setting-threshold");
const settingThresholdVal = document.getElementById("threshold-val");
const settingSilence = document.getElementById("setting-silence");
const settingSilenceVal = document.getElementById("silence-val");
const settingInstructions = document.getElementById("setting-instructions");
const settingsApply = document.getElementById("settings-apply");

// Shared token tooltip (lives in <body>, positioned via JS to avoid overflow clipping)
const tokenTooltipEl = document.createElement("div");
tokenTooltipEl.id = "token-tooltip";
document.body.appendChild(tokenTooltipEl);

function showTokenTooltip(anchor, rows, title) {
  tokenTooltipEl.innerHTML = "";
  const titleEl = document.createElement("div");
  titleEl.className = "token-tooltip-title";
  titleEl.textContent = title;
  tokenTooltipEl.appendChild(titleEl);
  rows.forEach(({ label, value, indent }) => {
    const row = document.createElement("div");
    row.className = "token-tooltip-row" + (indent ? " token-tooltip-row--indent" : "");
    const lbl = document.createElement("span");
    lbl.textContent = label;
    const dots = document.createElement("span");
    dots.className = "token-tooltip-dots";
    const val = document.createElement("span");
    val.className = "token-tooltip-val";
    val.textContent = value;
    row.append(lbl, dots, val);
    tokenTooltipEl.appendChild(row);
  });

  tokenTooltipEl.classList.add("visible");

  const rect = anchor.getBoundingClientRect();
  const tw = tokenTooltipEl.offsetWidth;
  const th = tokenTooltipEl.offsetHeight;
  const gap = 10;

  let top = rect.top - th - gap;
  if (top < 8) top = rect.bottom + gap;   // flip below if not enough room above

  let left = rect.left;
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
  if (left < 8) left = 8;

  tokenTooltipEl.style.top = `${top}px`;
  tokenTooltipEl.style.left = `${left}px`;
}

function hideTokenTooltip() {
  tokenTooltipEl.classList.remove("visible");
}

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

function openSettings() {
  settingsModal.hidden = false;
  settingsBtn.classList.add("active");
}

function closeSettings() {
  settingsModal.hidden = true;
  settingsBtn.classList.remove("active");
}

function getSelectedVoice() {
  return document.getElementById("voice-select")?.dataset.value || "masha";
}

function getSelectedLang() {
  return document.getElementById("lang-recog-select")?.dataset.value || "auto";
}

function getSelectedRole() {
  return document.getElementById("role-select")?.dataset.value || null;
}

function getSelectedModel() {
  return document.getElementById("model-select")?.dataset.value || "speech-realtime-250923";
}

const VOICE_ROLES = {
  // Female
  alena:     new Set(["neutral", "good"]),
  dasha:     new Set(["neutral", "good", "friendly"]),
  jane:      new Set(["neutral", "good", "evil"]),
  julia:     new Set(["neutral", "strict"]),
  lera:      new Set(["neutral", "friendly"]),
  marina:    new Set(["neutral", "whisper", "friendly"]),
  masha:     new Set(["good", "strict", "friendly"]),
  omazh:     new Set(["neutral", "evil"]),
  saule_ru:  new Set(["neutral", "strict", "whisper"]),
  yulduz_ru: new Set(["neutral", "strict", "friendly", "whisper"]),
  zamira_ru: new Set(["neutral", "strict", "friendly"]),
  zhanar_ru: new Set(["neutral", "strict", "friendly"]),
  // Male
  alexander: new Set(["neutral", "good"]),
  anton:     new Set(["neutral", "good"]),
  ermil:     new Set(["neutral", "good"]),
  filipp:    new Set([]),
  kirill:    new Set(["neutral", "strict", "good"]),
  madi_ru:   new Set([]),
  zahar:     new Set(["neutral", "good"]),
  // English
  john:      new Set([]),
  // German
  lea:       new Set([]),
  // Kazakh
  amira:     new Set([]),
  madi:      new Set([]),
  saule:     new Set(["neutral", "strict"]),
  zhanar:    new Set(["neutral", "friendly"]),
  // Uzbek
  nigora:    new Set([]),
  zamira:    new Set(["neutral", "strict", "friendly"]),
  yulduz:    new Set(["neutral", "strict", "friendly", "whisper"]),
  // Hebrew
  naomi:     new Set(["modern", "classic"]),
};

function setCustomSelectValue(selectEl, value) {
  const list = selectEl.querySelector(".custom-select__list");
  const btn  = selectEl.querySelector(".custom-select__btn span");
  const target = list.querySelector(`li[data-value="${value}"]`);
  if (!target) return;
  list.querySelectorAll("li").forEach(li => li.classList.remove("selected"));
  target.classList.add("selected");
  selectEl.dataset.value = value;
  btn.textContent = target.textContent;
}

function updateRoleOptions(voice) {
  const allowed = VOICE_ROLES[voice] ?? new Set(["neutral"]);
  const noRoles = allowed.size === 0;
  const roleSelect = document.getElementById("role-select");
  const roleBtn = roleSelect.querySelector(".custom-select__btn");

  roleBtn.disabled = noRoles;
  roleSelect.classList.toggle("no-roles", noRoles);

  roleSelect.querySelectorAll("li[data-value]").forEach(li => {
    li.classList.toggle("disabled", noRoles || !allowed.has(li.dataset.value));
  });

  if (noRoles) {
    roleSelect.dataset.value = "";
    roleSelect.querySelector(".custom-select__btn span").textContent = "—";
    roleSelect.querySelectorAll("li").forEach(li => li.classList.remove("selected"));
  } else if (!allowed.has(roleSelect.dataset.value)) {
    const fallback = allowed.has("neutral") ? "neutral"
      : allowed.has("friendly") ? "friendly"
      : [...allowed][0];
    setCustomSelectValue(roleSelect, fallback);
  }
}

function initCustomSelect(selectEl) {
  const btn  = selectEl.querySelector(".custom-select__btn");
  const list = selectEl.querySelector(".custom-select__list");

  btn.addEventListener("click", e => {
    e.stopPropagation();
    const opening = list.hidden;
    closeAllCustomSelects();
    if (opening) {
      list.hidden = false;
      selectEl.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    }
  });

  list.addEventListener("click", e => {
    const li = e.target.closest("li[data-value]");
    if (!li || li.classList.contains("disabled")) return;
    setCustomSelectValue(selectEl, li.dataset.value);
    list.hidden = true;
    selectEl.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function closeAllCustomSelects() {
  document.querySelectorAll(".custom-select.open").forEach(sel => {
    sel.classList.remove("open");
    sel.querySelector(".custom-select__list").hidden = true;
    sel.querySelector(".custom-select__btn").setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("click", closeAllCustomSelects);

document.querySelectorAll(".custom-select").forEach(initCustomSelect);

document.getElementById("voice-select").addEventListener("change", () => updateRoleOptions(getSelectedVoice()));

function updateVoiceOptions(lang) {
  const voiceSelect = document.getElementById("voice-select");
  voiceSelect.querySelectorAll("li").forEach(li => {
    const itemLang = li.classList.contains("custom-select__group")
      ? li.dataset.groupLang
      : li.dataset.lang;
    li.style.display = itemLang === lang ? "" : "none";
  });
  // Если текущий голос не принадлежит выбранному языку — переключить на первый доступный
  const current = voiceSelect.querySelector(`li[data-value="${getSelectedVoice()}"]`);
  if (!current || current.dataset.lang !== lang) {
    const first = voiceSelect.querySelector(`li[data-lang="${lang}"]`);
    if (first) {
      setCustomSelectValue(voiceSelect, first.dataset.value);
      updateRoleOptions(getSelectedVoice());
    }
  }
}

document.getElementById("lang-synth-select").addEventListener("change", () => {
  updateVoiceOptions(document.getElementById("lang-synth-select").dataset.value);
});

updateVoiceOptions("ru-RU");
updateRoleOptions(getSelectedVoice());

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
        ...(getSelectedRole() ? { role: getSelectedRole() } : {}),
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

settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);

settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettings();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsModal.hidden) closeSettings();
});

settingsApply.addEventListener("click", () => {
  const voice = getSelectedVoice();
  const modelChanged = getSelectedModel() !== connectedModel;
  // Голос без амплуа: реконнект для сброса стейта роли в сессии Yandex.
  // Модель задаётся только при подключении — её смена тоже требует реконнекта.
  const noRoles = (VOICE_ROLES[voice]?.size ?? 1) === 0;
  const needsReconnect = !!ws && (modelChanged || noRoles);

  // Реконнект обнуляет сессию Yandex и отвязывает загруженный документ —
  // спрашиваем подтверждение, если файл прикреплён.
  if (needsReconnect && currentVectorStoreId) {
    const reason = modelChanged ? "Смена модели" : "Выбранный голос";
    const ok = confirm(
      `${reason} требует переподключения, при котором загруженный документ ` +
      `«${currentFilename}» будет отвязан. Продолжить?`
    );
    if (!ok) {
      // Откатываем выбор модели к подключённой — UI не должен врать
      if (modelChanged) setCustomSelectValue(document.getElementById("model-select"), connectedModel);
      return; // модалка остаётся открытой
    }
  }

  closeSettings();
  if (needsReconnect) {
    reconnectAttempts = 0;
    ws.close();
  } else {
    applySettings();
  }
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
  // Модель зашита в URL соединения с Yandex на сервере — передаём её query-параметром.
  connectedModel = getSelectedModel();
  wsUrl.searchParams.set("model", connectedModel);
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

    // User speech transcription (may fire multiple times with growing text)
    case "conversation.item.input_audio_transcription.completed":
      if (msg.transcript) {
        upsertUserMessage(msg.item_id, msg.transcript);
      }
      break;

    // Tool call (custom event from server)
    case "tool_call":
      addToolCallMessage(msg.name, msg.arguments, msg.result);
      break;

    // User started speaking — new turn begins
    case "input_audio_buffer.speech_started":
      finalizeAssistantMessage(); // сбрасываем пузырёк: response.done мог не прийти при прерывании
      if (currentUserBubble) lastCompletedFullText = currentItemRawText || currentUserBubble.textContent || "";
      currentUserBubble = null;
      currentUserItemId = null;
      currentItemRawText = "";
      if (isRecording) stopPlayback();
      break;

    // Response complete
    case "response.done":
      finalizeAssistantMessage(msg.response?.usage);
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
    sentAudioSinceStart = true;
  };

  // Connect worklet through silent gain so it processes audio
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  isRecording = true;
  sentAudioSinceStart = false;
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

  // Commit audio buffer — только если реально что-то отправили,
  // иначе Yandex ответит ошибкой на пустой commit
  if (sentAudioSinceStart && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }
  sentAudioSinceStart = false;

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
function upsertUserMessage(itemId, text) {
  currentItemRawText = text;

  // Strip prefix already shown in a previous turn (Yandex sends cumulative transcripts)
  let displayText = text;
  if (!currentUserBubble && lastCompletedFullText && text.startsWith(lastCompletedFullText) && text.length > lastCompletedFullText.length) {
    displayText = text.substring(lastCompletedFullText.length).trimStart();
  }

  if (currentUserBubble && currentUserItemId === itemId) {
    currentUserBubble.textContent = displayText;
  } else {
    const div = document.createElement("div");
    div.className = "message user";
    div.textContent = displayText;
    chat.appendChild(div);
    currentUserBubble = div;
    currentUserItemId = itemId;
    lastUserQueryAt = performance.now();
    firstDeltaAt = null;
  }
  scrollToBottom();
}

function addUserMessage(text) {
  currentUserBubble = null;
  currentUserItemId = null;
  upsertUserMessage(null, text);
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

function buildTokenMeta(usage) {
  const inp = usage.input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const inDet = usage.input_token_details || {};
  const outDet = usage.output_token_details || {};

  const rows = [{ label: "Входящие", value: inp, indent: false }];
  if (inDet.text_tokens) rows.push({ label: "Текстовые", value: inDet.text_tokens, indent: true });
  if (inDet.cached_tokens) rows.push({ label: "Кэшированные", value: inDet.cached_tokens, indent: true });
  rows.push({ label: "Исходящие", value: out, indent: false });
  if (outDet.text_tokens) rows.push({ label: "Текстовые", value: outDet.text_tokens, indent: true });
  if (outDet.audio_tokens) rows.push({ label: "Аудио", value: outDet.audio_tokens, indent: true });

  const wrapper = document.createElement("span");
  wrapper.className = "token-meta";

  const summary = document.createElement("span");
  summary.className = "token-summary";
  summary.innerHTML =
    `Токены <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>` +
    ` ↓ ${inp} ↑ ${out}`;
  wrapper.appendChild(summary);

  wrapper.addEventListener("mouseenter", () => showTokenTooltip(wrapper, rows, "Потреблённые токены"));
  wrapper.addEventListener("mouseleave", hideTokenTooltip);

  return wrapper;
}

function finalizeAssistantMessage(usage = null) {
  // Если пузырька нет — это был только function_call без текста.
  // Сохраняем lastUserQueryAt, чтобы измерить latency финального ответа после тула.
  if (!currentAssistantBubble) return;

  if (lastUserQueryAt !== null && firstDeltaAt !== null) {
    const ttfr = Math.round(firstDeltaAt - lastUserQueryAt);
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const timeSpan = document.createElement("span");
    timeSpan.textContent = `${ttfr} мс`;
    meta.appendChild(timeSpan);
    if (usage) meta.appendChild(buildTokenMeta(usage));
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
