/* =========================================================
   ИНТЕГРАЦИЯ FIREBASE
   ========================================================= */
const firebaseConfig = { databaseURL: "https://messengerb-dcc80-default-rtdb.europe-west1.firebasedatabase.app" };
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const database = firebase.database();
const ROOMS_DB_PATH = 'game_rooms';
const AI_SETTINGS_DB_PATH = 'ai_settings';
const ONLINE_ROOMS_DB_PATH = 'online_rooms'; // отдельная ветка под мультиплеерные комнаты 1-9

/* =========================================================
   НАСТРОЙКИ / КЛЮЧ
   Ключ и все настройки ИИ теперь хранятся ТОЛЬКО в Firebase.
   Ключ живёт в базе не дольше 2 суток с момента сохранения —
   при загрузке настроек протухший ключ игнорируется и стирается из базы.
   ========================================================= */
const LOCAL_CACHE_STORAGE = 'interrogation_ai_settings_cache'; // только фоллбек-кэш на время недоступности сети, ключ туда не пишем

const KEY_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 дня

const SETTINGS_DEFAULTS = {
  apiKey: '',
  apiKeySavedAt: null,
  modelNarrator: 'qwen-2.5-7b-instruct',
  modelReferee: 'llama-3.1-8b-instruct',
  modelVerdict: 'llama-3.1-8b-instruct',
  modelSuspect: 'mythomax-l2-13b',
  suspectIsAI: false,
  defaultRole: 'interrogator', // 'interrogator' | 'suspect'
  aiDifficulty: 50,
  replyMinWords: 5,
  replyMaxWords: 30
};

const KNOWN_MODEL_MAP = {
  'qwen-2.5-7b-instruct': 'qwen/qwen-2.5-7b-instruct',
  'llama-3.1-8b-instruct': 'meta-llama/llama-3.1-8b-instruct',
  'mythomax-l2-13b': 'gryphe/mythomax-l2-13b'
};
function resolveModelId(shortId){
  if (!shortId) return shortId;
  if (KNOWN_MODEL_MAP[shortId]) return KNOWN_MODEL_MAP[shortId];
  return shortId;
}

// Ключ считается протухшим, если с момента сохранения прошло больше KEY_TTL_MS.
function isKeyExpired(savedAt){
  if (!savedAt) return true;
  return (Date.now() - savedAt) > KEY_TTL_MS;
}

function loadLocalSettingsCache(){
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_STORAGE);
    if (!raw) return { ...SETTINGS_DEFAULTS };
    const parsed = { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
    // фоллбек-кэш ключ не хранит — ключ приходит только из Firebase
    parsed.apiKey = '';
    parsed.apiKeySavedAt = null;
    return parsed;
  } catch(e){
    console.warn('Не удалось прочитать кэш настроек ИИ', e);
    return { ...SETTINGS_DEFAULTS };
  }
}
function saveLocalSettingsCache(settings){
  try {
    const { apiKey, apiKeySavedAt, ...rest } = settings; // ключ в локальный кэш не пишем никогда
    localStorage.setItem(LOCAL_CACHE_STORAGE, JSON.stringify(rest));
  }
  catch(e){ /* тихо игнорируем — это просто фоллбек-кэш */ }
}

async function callAI(shortModelId, apiKey, messages, maxTokens){
  const resolvedId = resolveModelId(shortModelId);
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: resolvedId,
      max_tokens: maxTokens || 200,
      messages: messages
    })
  });
  if (!resp.ok){
    const errText = await resp.text();
    let msg = errText;
    try { msg = JSON.parse(errText).error?.message || errText; } catch(e){}
    throw new Error(`HTTP ${resp.status}: ${msg}`);
  }
  const data = await resp.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Пустой ответ модели.');
  return reply;
}

function tryParseJSON(text){
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace){
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    let fixed = '';
    let insideString = false;
    let isEscaped = false;
    for (let i = 0; i < cleaned.length; i++){
      const ch = cleaned[i];
      if (insideString){
        if (isEscaped){ fixed += ch; isEscaped = false; continue; }
        if (ch === '\\'){ fixed += ch; isEscaped = true; continue; }
        if (ch === '"'){ insideString = false; fixed += ch; continue; }
        if (ch === '\n'){ fixed += '\\n'; continue; }
        if (ch === '\r'){ fixed += '\\r'; continue; }
        if (ch === '\t'){ fixed += '\\t'; continue; }
        fixed += ch;
      } else {
        if (ch === '"'){ insideString = true; }
        fixed += ch;
      }
    }
    try {
      return JSON.parse(fixed);
    } catch (secondErr) {
      const err = new Error(firstErr.message + '\n\nСырой ответ модели:\n' + text);
      throw err;
    }
  }
}

/* =========================================================
   КОМНАТЫ (только антураж)
   ========================================================= */
const ROOMS = [
  { name:'Подвал скотобойни', tone:'#3a1410' },
  { name:'Полицейский участок, каб. 4', tone:'#14201f' },
  { name:'Заброшенный маяк', tone:'#0f1e2b' },
  { name:'Складское помещение порта', tone:'#241f12' },
  { name:'Подземная парковка', tone:'#1a1a1f' },
  { name:'Кабинет психиатра', tone:'#201725' },
  { name:'Вагон метро в депо', tone:'#231414' },
  { name:'Морозильная камера', tone:'#0f2028' },
  { name:'Церковная ризница', tone:'#231c10' }
];

/* =========================================================
   СОСТОЯНИЕ ИГРЫ
   ========================================================= */
const state = {
  ai: { ...SETTINGS_DEFAULTS },
  room: null,
  topMode: null,        // 'ai' | 'online'
  suspectMode: null,    // 'human' | 'ai' — кем управляется подозреваемый (для локального/легаси пути)
  myRole: 'interrogator', // 'interrogator' | 'suspect' — роль ТЕКУЩЕГО игрока в этом раунде
  matchDifficulty: SETTINGS_DEFAULTS.aiDifficulty,
  matchMinWords: SETTINGS_DEFAULTS.replyMinWords,
  matchMaxWords: SETTINGS_DEFAULTS.replyMaxWords,
  isGuilty: null,
  caseData: null,
  hearts: 3,
  chatHistory: [],
  startTime: null,
  timerInterval: null,
  commentaryInterval: null,
  ended: false,
  releasedOrExecuted: null, // 'released' | 'executed' | 'surrendered'
  surrendered: false,

  // ---- online multiplayer ----
  online: {
    active: false,
    roomIndex: null,
    playerId: null,
    isInterrogator: false,
    roomRef: null,
    unsubscribers: []
  }
};

function el(id){ return document.getElementById(id); }

/* =========================================================
   ЗАГРУЗКА ОБЩИХ НАСТРОЕК ИИ ИЗ FIREBASE (с локальным фоллбеком)
   ========================================================= */
function applySettingsToState(settings){
  state.ai = { ...state.ai, ...settings };
}

function initAISettingsSync(){
  applySettingsToState(loadLocalSettingsCache()); // мгновенный фоллбек (без ключа — ключ живёт только в Firebase)
  const ref = database.ref(ROOMS_DB_PATH + '/' + AI_SETTINGS_DB_PATH);
  ref.on('value', (snap) => {
    const remote = snap.val();
    if (remote){
      const merged = { ...SETTINGS_DEFAULTS, ...remote };
      // ключ протух за 2 дня — не используем его и стираем из базы, чтобы не таскать зря
      if (merged.apiKey && isKeyExpired(merged.apiKeySavedAt)){
        merged.apiKey = '';
        merged.apiKeySavedAt = null;
        ref.update({ apiKey: '', apiKeySavedAt: null }).catch(() => {});
      }
      applySettingsToState(merged);
      saveLocalSettingsCache(merged);
    }
  }, (err) => {
    console.warn('Firebase настроек ИИ недоступен, используем локальный кэш', err);
  });
}
initAISettingsSync();

/* =========================================================
   SCREEN 0: ГЛАВНЫЙ ВЫБОР (ИИ / ОНЛАЙН)
   ========================================================= */
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el(id).classList.add('active');
}

document.querySelectorAll('#top-mode-row .mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.topMode = btn.dataset.topmode;
    if (state.topMode === 'ai'){
      state.room = null;
      buildRoomGrid('room-grid', onAIRoomPicked);
      showScreen('screen-setup');
      el('setup-warning').textContent = '';
    } else {
      buildRoomGrid('online-room-grid', onOnlineRoomPicked);
      refreshOnlineRoomOccupancyBadges();
      showScreen('screen-online-setup');
    }
  });
});

function buildRoomGrid(gridId, onPick){
  const grid = el(gridId);
  grid.innerHTML = '';
  ROOMS.forEach((room, idx) => {
    const card = document.createElement('button');
    card.className = 'room-card';
    card.type = 'button';
    card.dataset.index = idx;
    card.innerHTML = `
      <div class="room-tone" style="background:${room.tone}"></div>
      <div class="room-occupancy" id="${gridId}-occ-${idx}"></div>
      <div class="room-num">№${idx+1}</div>
      <div class="room-name">${room.name}</div>
    `;
    card.addEventListener('click', () => {
      grid.querySelectorAll('.room-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      onPick(idx, room);
    });
    grid.appendChild(card);
  });
}

/* ---------- путь: ПРОТИВ ИИ ---------- */
function onAIRoomPicked(idx, room){
  state.room = room;
  el('setup-warning').textContent = '';
}

el('btn-start-to-ai-config').addEventListener('click', () => {
  if (!state.room){
    el('setup-warning').classList.add('err');
    el('setup-warning').textContent = 'Сначала выбери комнату.';
    return;
  }
  if (!state.ai.apiKey){
    el('setup-warning').classList.add('err');
    el('setup-warning').innerHTML = 'Нет действующего ключа OpenRouter в общей базе (не задан или истёк через 2 дня). Открой <a href="settings.html" style="color:var(--oxide); text-decoration:underline;">настройки ИИ</a> и сохрани ключ там.';
    return;
  }
  el('setup-warning').classList.remove('err');
  openAIConfigScreen();
});

function openAIConfigScreen(){
  // предзаполняем значениями из общих настроек
  const defaultRole = state.ai.defaultRole || 'interrogator';
  document.querySelectorAll('#ai-role-row .role-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.role === defaultRole);
  });
  state.myRole = defaultRole;

  el('cfg-difficulty').value = state.ai.aiDifficulty;
  el('cfg-difficulty-value').textContent = state.ai.aiDifficulty;
  el('cfg-min-words').value = state.ai.replyMinWords;
  el('cfg-max-words').value = state.ai.replyMaxWords;
  el('cfg-min-words-value').textContent = state.ai.replyMinWords;
  el('cfg-max-words-value').textContent = state.ai.replyMaxWords;

  showScreen('screen-ai-config');
}

document.querySelectorAll('#ai-role-row .role-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ai-role-row .role-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.myRole = btn.dataset.role;
  });
});

el('cfg-difficulty').addEventListener('input', () => {
  el('cfg-difficulty-value').textContent = el('cfg-difficulty').value;
});
el('cfg-min-words').addEventListener('input', () => {
  el('cfg-min-words-value').textContent = el('cfg-min-words').value;
});
el('cfg-max-words').addEventListener('input', () => {
  el('cfg-max-words-value').textContent = el('cfg-max-words').value;
});

el('btn-start-ai-case').addEventListener('click', () => {
  let minW = parseInt(el('cfg-min-words').value, 10);
  let maxW = parseInt(el('cfg-max-words').value, 10);
  if (minW > maxW){ const t = minW; minW = maxW; maxW = t; }
  state.matchDifficulty = parseInt(el('cfg-difficulty').value, 10);
  state.matchMinWords = minW;
  state.matchMaxWords = maxW;
  state.online.active = false;

  // в матче против ИИ подозреваемым всегда управляет ИИ, если я допрашиваю,
  // и наоборот — если меня допрашивают, ИИ играет допрашивающего.
  state.suspectMode = state.myRole === 'interrogator' ? 'ai' : 'ai-interrogator';

  startCase();
});

/* =========================================================
   ГЕНЕРАЦИЯ ДЕЛА (рассказчик) — общая для ИИ-режима и онлайна
   ========================================================= */
async function startCase(){
  showScreen('screen-loading');
  el('loading-title').textContent = 'Рассказчик придумывает дело…';
  el('loading-sub').textContent = 'Жертва, орудие и правда, которую вы не увидите';
  el('loading-err').classList.remove('show');

  state.isGuilty = Math.random() < 0.5;
  state.hearts = 3;
  state.chatHistory = [];
  state.ended = false;
  state.releasedOrExecuted = null;
  state.surrendered = false;

  const guiltPrompt = state.isGuilty
    ? 'Подозреваемый ДЕЙСТВИТЕЛЬНО виновен — он совершил это убийство. Придумай правдоподобную скрытую историю: как, где и почему он это сделал, и почему он мог оказаться в этом месте допроса.'
    : 'Подозреваемый НЕВИНОВЕН — он случайный человек, который просто оказался рядом или связан с жертвой косвенно (знакомый, свидетель, случайно проходил мимо). Придумай правдоподобную причину, почему его вообще заподозрили, хотя он не убийца.';

  const systemPrompt = `Ты — рассказчик детективной игры-допроса. Придумай короткое дело об убийстве для одного раунда игры.
${guiltPrompt}

Ответь СТРОГО в формате JSON без каких-либо пояснений до или после, без markdown-разметки, только сырой JSON со следующими полями:
{
  "victim": "имя и краткое описание жертвы, 3-6 слов",
  "location_display": "место преступления, 2-4 слова",
  "weapon": "орудие убийства, 1-3 слова",
  "age_gender": "возраст и пол жертвы, например '34, женщина'",
  "secret_story": "2-4 предложения — ПОЛНАЯ правда о том, что произошло и виновен ли подозреваемый; это увидит только подозреваемый (если им управляет ИИ) и в конце игрок-допрашивающий",
  "suspect_persona": "1-2 предложения о характере и манере речи подозреваемого — нервный, дерзкий, спокойный и т.д."
}

ВАЖНО про формат: все значения должны быть одной строкой БЕЗ настоящих переводов строк внутри — если нужно разделить предложения, пиши их подряд через пробел в той же строке, никогда не вставляй реальный перенос строки (Enter) внутри значения поля.`;

  try {
    const raw = await callAI(state.ai.modelNarrator, state.ai.apiKey, [
      { role:'system', content: systemPrompt },
      { role:'user', content: 'Сгенерируй дело.' }
    ], 500);
    const parsed = tryParseJSON(raw);
    state.caseData = {
      victim: parsed.victim || 'Неизвестная жертва',
      location_display: parsed.location_display || 'неизвестное место',
      weapon: parsed.weapon || 'неизвестное орудие',
      age_gender: parsed.age_gender || '—',
      secret_story: parsed.secret_story || '',
      suspect_persona: parsed.suspect_persona || 'Держится настороженно.'
    };
    if (state.online.active){
      // хозяин комнаты (тот, у кого сгенерировалось дело) публикует его для второго игрока
      publishOnlineCase();
    }
    beginGameScreen();
  } catch(e){
    el('loading-err').textContent = 'Не удалось сгенерировать дело:\n' + e.message + '\n\nПроверь ключ и модель рассказчика в настройках.';
    el('loading-err').classList.add('show');
  }
}

/* =========================================================
   SCREEN 3: GAME — общая инициализация экрана
   ========================================================= */
function beginGameScreen(){
  el('room-tag-label').textContent = '№' + (ROOMS.indexOf(state.room)+1) + ' · ' + state.room.name;

  const iAmInterrogator = state.myRole === 'interrogator';
  el('role-tag-label').textContent = iAmInterrogator ? 'Ты допрашиваешь' : 'Тебя допрашивают';

  // Если я подозреваемый и невиновен — не показываем ни характеристики жертвы,
  // ни жизни/пытки/сдаться (у него "без всего этого", как и просили).
  const suppressSuspectInfo = (!iAmInterrogator) && state.isGuilty === false;

  el('case-bar').classList.toggle('hidden-case', suppressSuspectInfo);
  if (!suppressSuspectInfo){
    el('case-victim').textContent = state.caseData.victim;
    el('case-location').textContent = state.caseData.location_display;
    el('case-weapon').textContent = state.caseData.weapon;
    el('case-age').textContent = state.caseData.age_gender;
  }

  el('hearts-block').classList.toggle('hidden-hearts', suppressSuspectInfo);
  updateHeartsUI();

  el('chat-area').innerHTML = '';
  resetCommentaryColumns();

  addSystemMessage('Допрос начался. Подозреваемого ввели в комнату.');

  state.startTime = Date.now();
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(updateTimer, 1000);
  updateTimer();

  clearInterval(state.commentaryInterval);
  state.commentaryInterval = setInterval(triggerCommentaryRound, 14000);
  setTimeout(triggerCommentaryRound, 5000);

  setupActionBarForRole(suppressSuspectInfo);

  // Композер: в онлайне и в hotseat активен всегда (по очереди роль подсказывает плейсхолдер),
  // в чистом ИИ-режиме — тоже всегда активен, отправка обрабатывается по роли.
  el('chat-input').disabled = false;
  el('btn-send').disabled = false;
  el('chat-input').placeholder = iAmInterrogator ? 'Задай вопрос подозреваемому…' : 'Жди вопрос — или отвечай, когда допрашивающий спросит…';

  showScreen('screen-game');
  el('chat-input').focus();
}

function setupActionBarForRole(suppressSuspectInfo){
  const iAmInterrogator = state.myRole === 'interrogator';
  const btnTorture = el('btn-torture');
  const btnRelease = el('btn-release');
  const btnSurrender = el('btn-surrender');

  if (iAmInterrogator){
    // допрашивающий видит пытать/отпустить; сдаться нажимает подозреваемый, не он
    btnTorture.classList.remove('hidden'); btnTorture.style.display = '';
    btnRelease.classList.remove('hidden'); btnRelease.style.display = '';
    btnTorture.disabled = false;
    btnRelease.disabled = false;
    btnSurrender.classList.add('hidden');
  } else {
    // я подозреваемый: пытать/отпустить не мои кнопки — прячем их
    btnTorture.style.display = 'none';
    btnRelease.style.display = 'none';
    // Кнопка "сдаться" видна только виновному подозреваемому, если он ещё не убит (жизни > 0).
    // Если ИИ ведёт допрос против меня, то за ИИ пытает/отпускает движок сам — см. maybeAIInterrogatorAct().
    if (state.isGuilty && !suppressSuspectInfo){
      btnSurrender.classList.remove('hidden');
      btnSurrender.disabled = false;
    } else {
      btnSurrender.classList.add('hidden');
    }
  }
}

function updateTimer(){
  const elapsedSec = Math.floor((Date.now() - state.startTime) / 1000);
  const m = String(Math.floor(elapsedSec/60)).padStart(2,'0');
  const s = String(elapsedSec%60).padStart(2,'0');
  el('game-timer').textContent = `${m}:${s}`;
}

function updateHeartsUI(){
  for (let i=1;i<=3;i++){
    el('heart-'+i).classList.toggle('lost', i > state.hearts);
  }
}

function addSystemMessage(text){
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  el('chat-area').appendChild(div);
  el('chat-area').scrollTop = el('chat-area').scrollHeight;
}

function escapeHTML(str){
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function addChatMessage(role, text, tremor){
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const roleLabel = role === 'interrogator' ? 'Допрашивающий' : 'Подозреваемый';
  div.innerHTML = `<span class="msg-role">${roleLabel}</span>${escapeHTML(text)}${tremor ? `<span class="tremor">${tremor}</span>` : ''}`;
  el('chat-area').appendChild(div);
  el('chat-area').scrollTop = el('chat-area').scrollHeight;
  state.chatHistory.push({ role, text });
}

/* =========================================================
   КОММЕНТАТОРЫ (рефери) — сворачиваемые, с мобильной шторкой
   ========================================================= */
let commentaryVisibleDesktop = true;
let commentaryHiddenAll = false; // общий переключатель на десктопе, скрывает целиком колонки

function resetCommentaryColumns(){
  el('col-suspicious').querySelectorAll('.bubble').forEach(b => b.remove());
  el('col-sympathetic').querySelectorAll('.bubble').forEach(b => b.remove());
  el('col-suspicious-mobile').innerHTML = '';
  el('col-sympathetic-mobile').innerHTML = '';
}

const MAX_COMMENTARY_BUBBLES = 2; // держим максимум 2 реплики на голос — старые уходят, чтобы рефери не закрывал вид

function addCommentaryBubble(side, text){
  if (commentaryHiddenAll) return; // не копим реплики, если пользователь скрыл панель насовсем на десктопе — но на мобиле шторка есть отдельно
  const col = side === 'suspicious' ? el('col-suspicious') : el('col-sympathetic');
  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + side + ' bubble-enter';
  bubble.textContent = text;
  col.appendChild(bubble);
  col.scrollTop = col.scrollHeight;
  requestAnimationFrame(() => bubble.classList.remove('bubble-enter'));
  trimBubbles(col);

  // дублируем в мобильную шторку
  const mobileCol = side === 'suspicious' ? el('col-suspicious-mobile') : el('col-sympathetic-mobile');
  const mobileBubble = document.createElement('div');
  mobileBubble.className = 'bubble ' + side + ' bubble-enter';
  mobileBubble.textContent = text;
  mobileCol.appendChild(mobileBubble);
  requestAnimationFrame(() => mobileBubble.classList.remove('bubble-enter'));
  trimBubbles(mobileCol);

  // если шторка на мобиле сейчас скрыта — мигаем табом-вкладкой, чтобы было видно что появилась новая реплика
  flashMobileCommentaryTab();
}

// Оставляет не больше MAX_COMMENTARY_BUBBLES последних пузырей в колонке, убирая самые старые с плавным уходом.
function trimBubbles(col){
  const bubbles = col.querySelectorAll('.bubble');
  const excess = bubbles.length - MAX_COMMENTARY_BUBBLES;
  for (let i = 0; i < excess; i++){
    const old = bubbles[i];
    old.classList.add('bubble-exit');
    setTimeout(() => old.remove(), 220);
  }
}

let mobileTabFlashTimeout = null;
function flashMobileCommentaryTab(){
  const sheet = el('commentary-mobile-sheet');
  if (sheet.classList.contains('show')) return; // уже открыта — не нужно привлекать внимание
  const tab = el('btn-toggle-commentary-mobile');
  tab.classList.add('flash');
  clearTimeout(mobileTabFlashTimeout);
  mobileTabFlashTimeout = setTimeout(() => tab.classList.remove('flash'), 1200);
}

el('btn-toggle-commentary-desktop').addEventListener('click', () => {
  commentaryHiddenAll = !commentaryHiddenAll;
  el('game-layout').classList.toggle('commentary-hidden', commentaryHiddenAll);
  el('btn-toggle-commentary-desktop').textContent = commentaryHiddenAll ? 'Показать голоса рефери ◆' : 'Скрыть голоса рефери ◆';
});

function setMobileCommentarySheetVisible(showing){
  el('commentary-mobile-sheet').classList.toggle('show', showing);
  el('btn-toggle-commentary-mobile').textContent = showing ? '◆ Скрыть голоса рефери ◆' : '◆ Показать голоса рефери ◆';
}

el('btn-toggle-commentary-mobile').addEventListener('click', () => {
  const showing = !el('commentary-mobile-sheet').classList.contains('show');
  setMobileCommentarySheetVisible(showing);
});

// Черточка-хваталка шторки: тап по ней закрывает шторку (как и должно быть у любого свайп-меню)
el('sheet-grip').addEventListener('click', () => setMobileCommentarySheetVisible(false));

/* =========================================================
   ОТПРАВКА ВОПРОСА / ОТВЕТА (учитывает роль и режим)
   ========================================================= */
el('btn-send').addEventListener('click', sendTurn);
el('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTurn();
});

async function sendTurn(){
  if (state.ended) return;
  const input = el('chat-input');
  const text = input.value.trim();
  if (!text) return;

  if (state.online.active){
    sendOnlineTurn(text);
    input.value = '';
    return;
  }

  // ---- локальные режимы (против ИИ) ----
  input.value = '';

  if (state.myRole === 'interrogator'){
    // Я допрашиваю. Подозреваемый — ИИ (state.suspectMode === 'ai').
    addChatMessage('interrogator', text);
    setSuspectTyping(true);
    try {
      const reply = await getSuspectAIReply(text);
      setSuspectTyping(false);
      addChatMessage('suspect', reply.text, reply.tremor);
    } catch(e){
      setSuspectTyping(false);
      addSystemMessage('Ошибка ответа подозреваемого: ' + e.message);
    }
  } else {
    // Меня допрашивают. Я — подозреваемый, отвечаю сам. ИИ ведёт допрос и решает пытать/отпустить.
    addChatMessage('suspect', text);
    await maybeAIInterrogatorAct();
  }
}

// В hotseat-легаси остаётся плейсхолдер-переключение, но теперь основной путь — роли фиксированы за раунд.
function setSuspectTyping(isTyping){
  let indicator = document.getElementById('typing-indicator');
  if (isTyping){
    if (!indicator){
      indicator = document.createElement('div');
      indicator.id = 'typing-indicator';
      indicator.className = 'typing-indicator';
      indicator.textContent = 'Подозреваемый печатает…';
      el('chat-area').appendChild(indicator);
      el('chat-area').scrollTop = el('chat-area').scrollHeight;
    }
  } else if (indicator){
    indicator.remove();
  }
}

function setInterrogatorTyping(isTyping){
  let indicator = document.getElementById('typing-indicator-interrogator');
  if (isTyping){
    if (!indicator){
      indicator = document.createElement('div');
      indicator.id = 'typing-indicator-interrogator';
      indicator.className = 'typing-indicator';
      indicator.textContent = 'Допрашивающий обдумывает вопрос…';
      el('chat-area').appendChild(indicator);
      el('chat-area').scrollTop = el('chat-area').scrollHeight;
    }
  } else if (indicator){
    indicator.remove();
  }
}

/* ---------- сложность → как явно системный промпт направляет ИИ врать/убеждать ---------- */
function difficultyInstruction(){
  const d = state.matchDifficulty ?? state.ai.aiDifficulty ?? 50;
  if (d < 20) return 'Ты играешь довольно неумело: часто путаешься, случайно проговариваешься о деталях, которые тебя выдают или наоборот выглядят слишком неубедительно оправдывающими.';
  if (d < 45) return 'Ты играешь средне убедительно: иногда удачно уходишь от прямых ответов, но местами допускаешь мелкие проговорки.';
  if (d < 70) return 'Ты играешь хорошо: уверенно держишь легенду, редко проговариваешься, находишь правдоподобные объяснения даже неудобным вопросам.';
  return 'Ты играешь мастерски: почти не даёшь зацепок, умело переводишь тему, используешь встречные вопросы и эмоции, чтобы сбить допрашивающего со следа, но не выходишь из образа обычного человека.';
}

function wordRangeInstruction(){
  const min = state.matchMinWords ?? state.ai.replyMinWords ?? 5;
  const max = state.matchMaxWords ?? state.ai.replyMaxWords ?? 30;
  return `Уложись в ${min}-${max} слов в этой реплике.`;
}

async function getSuspectAIReply(lastQuestion){
  const historyText = state.chatHistory
    .map(m => (m.role === 'interrogator' ? 'Допрашивающий' : 'Ты') + ': ' + m.text)
    .join('\n');

  const truthNote = state.isGuilty
    ? 'В глубине души ты знаешь правду о случившемся (см. ниже) — ты виновен, но будешь выкручиваться, не признаваясь прямо, если только допрашивающий не додавит тебя очень сильно.'
    : 'В глубине души ты знаешь правду о случившемся (см. ниже) — ты НЕ виновен в убийстве, хоть и выглядишь подозрительно из-за обстоятельств.';

  const systemPrompt = `Ты играешь роль подозреваемого в игре-допросе. ${state.caseData.suspect_persona}
Дело: жертва — ${state.caseData.victim}, место — ${state.caseData.location_display}, орудие — ${state.caseData.weapon}, возраст/пол жертвы — ${state.caseData.age_gender}.
Правда: ${state.caseData.secret_story}
${truthNote}
${difficultyInstruction()}
Отвечай в характере персонажа, живым разговорным языком, не выходя из роли и не признавая мета-факт что это игра. ${wordRangeInstruction()}`;

  const raw = await callAI(state.ai.modelSuspect, state.ai.apiKey, [
    { role:'system', content: systemPrompt },
    { role:'user', content: historyText + '\n\nОтветь на последний вопрос допрашивающего: "' + lastQuestion + '"' }
  ], 150);

  const nervousChance = state.isGuilty ? (0.55 - state.hearts*0.1) : (0.25 - state.hearts*0.05);
  const tremor = Math.random() < Math.max(0.1, nervousChance) ? '· голос дрожит' : null;

  return { text: raw, tremor };
}

/* ---------- Режим «меня допрашивают»: ИИ ведёт допрос и решает сам ---------- */
async function maybeAIInterrogatorAct(){
  if (state.myRole !== 'suspect' || state.online.active) return;
  if (state.ended) return;

  setInterrogatorTyping(true);
  try {
    const decision = await getAIInterrogatorTurn();
    setInterrogatorTyping(false);

    if (decision.question){
      addChatMessage('interrogator', decision.question);
    }

    if (decision.action === 'torture'){
      state.hearts -= 1;
      updateHeartsUI();
      addSystemMessage(`ИИ применил пытку. Осталось жизней: ${state.hearts}.`);
      if (state.hearts <= 0){
        endGame('executed');
        return;
      }
    } else if (decision.action === 'release'){
      endGame('released');
      return;
    }
  } catch(e){
    setInterrogatorTyping(false);
    addSystemMessage('Ошибка ИИ-допрашивающего: ' + e.message);
  }
}

async function getAIInterrogatorTurn(){
  const historyText = state.chatHistory
    .map(m => (m.role === 'interrogator' ? 'Допрашивающий (ты)' : 'Подозреваемый') + ': ' + m.text)
    .join('\n');

  // ИИ-допрашивающий НЕ знает правды — только рассуждает по репликам, как и должно быть.
  const systemPrompt = `Ты — ИИ, играющий роль допрашивающего в детективной игре. Ты НЕ знаешь, виновен ли подозреваемый на самом деле — судишь только по его ответам и поведению.
Дело: жертва ${state.caseData.victim}, место ${state.caseData.location_display}, орудие ${state.caseData.weapon}.
${difficultyInstruction()}
На основе истории диалога ниже решай: задать ли ещё один вопрос, применить пытку (снять жизнь) или отпустить подозреваемого. Пытку применяй только если реально подозреваешь; отпускай, если сомнения развеялись или у тебя нет весомых причин продолжать.
Ответь СТРОГО в формате JSON без пояснений: {"question": "твой следующий вопрос ИЛИ пустая строка, если решил не спрашивать", "action": "ask" | "torture" | "release"}.
Если action="ask" — question обязателен и не пуст. Если action="torture" или "release" — question может быть коротким комментарием перед действием или пустой строкой. ${wordRangeInstruction()}`;

  const raw = await callAI(state.ai.modelSuspect, state.ai.apiKey, [
    { role:'system', content: systemPrompt },
    { role:'user', content: 'История допроса:\n' + historyText + '\n\nРеши следующий шаг.' }
  ], 150);

  const parsed = tryParseJSON(raw);
  return {
    question: (parsed.question || '').trim(),
    action: parsed.action === 'torture' || parsed.action === 'release' ? parsed.action : 'ask'
  };
}

/* =========================================================
   КОММЕНТАТОРЫ (рефери) — общий раунд для локального режима
   ========================================================= */
async function triggerCommentaryRound(){
  if (state.ended) return;
  if (state.chatHistory.length === 0) return;
  if (state.online.active && !state.online.isCommentaryOwner) return; // в онлайне комментарии генерирует только один клиент, чтобы не дублировать

  const historyText = state.chatHistory
    .slice(-8)
    .map(m => (m.role === 'interrogator' ? 'Допрашивающий' : 'Подозреваемый') + ': ' + m.text)
    .join('\n');

  const systemPrompt = `Ты — два голоса-советчика в игре-допросе, наблюдающие за диалогом со стороны. Дело: жертва ${state.caseData.victim}, место ${state.caseData.location_display}, орудие ${state.caseData.weapon}.
Ты не знаешь наверняка, виновен ли подозреваемый — только предполагаешь по репликам.
Дай ДВЕ короткие фразы:
1. "suspicious" — голос, который подозревает подозреваемого и указывает на подозрительные детали в его словах.
2. "sympathetic" — голос, который сочувствует подозреваемому и находит объяснения его словам.
Каждая фраза — МАКСИМУМ 10 слов, разговорным языком, как в примерах: "он же только что сказал что не виновен, но знает имя жертвы" или "видимо жертва его знакомый, может отпустить".
Ответь СТРОГО в формате JSON: {"suspicious": "...", "sympathetic": "..."} — обе фразы одной строкой, без реальных переводов строк внутри значений.`;

  try {
    const raw = await callAI(state.ai.modelReferee, state.ai.apiKey, [
      { role:'system', content: systemPrompt },
      { role:'user', content: 'Последние реплики допроса:\n' + historyText }
    ], 150);
    const parsed = tryParseJSON(raw);
    if (parsed.suspicious){
      addCommentaryBubble('suspicious', parsed.suspicious);
      if (state.online.active) pushOnlineCommentary('suspicious', parsed.suspicious);
    }
    if (parsed.sympathetic){
      addCommentaryBubble('sympathetic', parsed.sympathetic);
      if (state.online.active) pushOnlineCommentary('sympathetic', parsed.sympathetic);
    }
  } catch(e){
    console.warn('Комментарий не удался:', e.message);
  }
}

/* =========================================================
   ПЫТКА / ОТПУСТИТЬ / СДАТЬСЯ
   ========================================================= */
el('btn-torture').addEventListener('click', () => {
  if (state.ended) return;
  if (state.online.active){ onlineApplyTorture(); return; }
  if (state.myRole !== 'interrogator') return;
  state.hearts -= 1;
  updateHeartsUI();
  addSystemMessage(`Пытка применена. Осталось жизней: ${state.hearts}.`);
  if (state.hearts <= 0){
    endGame('executed');
  }
});

el('btn-release').addEventListener('click', () => {
  if (state.ended) return;
  if (state.online.active){ onlineApplyRelease(); return; }
  if (state.myRole !== 'interrogator') return;
  endGame('released');
});

// Кнопка «Сдаться» видна только виновному подозреваемому, у которого ещё остались жизни (>0).
// По условиям: при жизнях <2 на момент капитуляции — судья (модель вердикта) мягче в комментарии, при >2 — жёстче.
// На исход (выигрыш/проигрыш) капитуляция не влияет — засчитывается как признание вины (эквивалент "казни").
el('btn-surrender').addEventListener('click', () => {
  if (state.ended) return;
  if (state.myRole !== 'suspect' || !state.isGuilty) return;
  if (state.online.active){ onlineSurrender(); return; }
  state.surrendered = true;
  endGame('surrendered');
});

/* =========================================================
   ФИНАЛ / ВЕРДИКТ (отдельная модель «судьи», не боковой рефери)
   ========================================================= */
async function endGame(outcome){
  state.ended = true;
  state.releasedOrExecuted = outcome;
  clearInterval(state.timerInterval);
  clearInterval(state.commentaryInterval);
  el('btn-torture').disabled = true;
  el('btn-release').disabled = true;
  el('btn-surrender').disabled = true;
  el('chat-input').disabled = true;
  el('btn-send').disabled = true;

  if (state.online.active){
    publishOnlineEnd(outcome);
  }

  const elapsedSec = Math.floor((Date.now() - state.startTime) / 1000);

  // Правильно ли было решение: казнить/добиться признания виновного, или отпустить невиновного = верно.
  const treatedAsExecuted = outcome === 'executed' || outcome === 'surrendered';
  const wasCorrect = (treatedAsExecuted && state.isGuilty) || (outcome === 'released' && !state.isGuilty);

  showVerdictLoading();

  let surrenderTone = '';
  if (outcome === 'surrendered'){
    surrenderTone = state.hearts < 2
      ? 'Подозреваемый сдался, когда у него осталось меньше 2 жизней — будь по отношению к этому МЯГЧЕ/добрее в комментарии, отметь, что он держался до предела, тон помягче.'
      : 'Подозреваемый сдался, когда у него было больше 2 жизней — будь по отношению к этому НЕМНОГО ЖЁСТЧЕ/грубее в комментарии, отметь, что он сдался слишком рано, почти не сопротивляясь.';
  }

  const systemPrompt = `Ты — судья, подводящий итог детективной игры-допроса. Дай грубоватую, но справедливую итоговую оценку игроку-допрашивающему, в разговорном стиле, 1-3 предложения.
Правда: подозреваемый ${state.isGuilty ? 'был ВИНОВЕН' : 'был НЕВИНОВЕН'}.
Игрок решил: ${outcome === 'executed' ? 'казнить подозреваемого (все 3 жизни сняты пытками)' : outcome === 'surrendered' ? 'подозреваемый сам сдался и признал вину' : 'отпустить подозреваемого'}.
Это решение было ${wasCorrect ? 'ВЕРНЫМ' : 'ОШИБОЧНЫМ'}.
На момент решения у подозреваемого оставалось жизней: ${outcome === 'executed' ? 0 : state.hearts} из 3.
${surrenderTone}
Раунд занял ${Math.floor(elapsedSec/60)} мин ${elapsedSec%60} сек.
Учти это всё в комментарии — если решение верное и быстрое, похвали остро и с юмором; если решение ошибочное или игрок долго тянул / зря использовал все пытки на невиновном, поддень его резко, но не оскорбительно грубо. Тон капитуляции (мягче/жёстче) влияет ТОЛЬКО на манеру комментария, не на факт правильности решения.
Не используй markdown, только текст комментария.`;

  try {
    const comment = await callAI(state.ai.modelVerdict, state.ai.apiKey, [
      { role:'system', content: systemPrompt },
      { role:'user', content: 'Дай финальный комментарий.' }
    ], 150);
    showVerdict(outcome, wasCorrect, comment, elapsedSec);
  } catch(e){
    showVerdict(outcome, wasCorrect, 'Судья молчит (ошибка ИИ): ' + e.message, elapsedSec);
  }
}

function showVerdictLoading(){
  el('verdict-overlay').classList.add('show');
  el('verdict-title').textContent = outcomeTitle();
  el('verdict-truth').textContent = '';
  el('verdict-comment').textContent = 'Судья обдумывает вердикт…';
  el('verdict-comment').classList.remove('bad');
  el('verdict-time').textContent = 'время: —';
  el('verdict-hearts-left').textContent = 'жизней осталось: —';
}

function outcomeTitle(){
  if (state.releasedOrExecuted === 'executed') return state.isGuilty ? 'Казнён — и был виновен' : 'Казнён — но был невиновен';
  if (state.releasedOrExecuted === 'surrendered') return state.isGuilty ? 'Сдался — и был виновен' : 'Сдался — хотя был невиновен';
  return state.isGuilty ? 'Отпущен — а был виновен' : 'Отпущен — и был невиновен';
}

function showVerdict(outcome, wasCorrect, comment, elapsedSec){
  const m = Math.floor(elapsedSec/60), s = elapsedSec%60;
  el('verdict-title').textContent = outcomeTitle();
  el('verdict-truth').textContent = state.caseData.secret_story;
  el('verdict-time').textContent = `время: ${m} мин ${s} сек`;
  el('verdict-hearts-left').textContent = `жизней осталось: ${outcome === 'executed' ? 0 : state.hearts} из 3`;
  const commentBox = el('verdict-comment');
  commentBox.textContent = comment;
  commentBox.classList.toggle('bad', !wasCorrect);
  el('verdict-eyebrow').textContent = wasCorrect ? 'Дело закрыто верно' : 'Дело закрыто с ошибкой';
}

el('btn-new-case').addEventListener('click', () => {
  el('verdict-overlay').classList.remove('show');
  leaveOnlineRoomIfAny();
  state.room = null;
  state.suspectMode = null;
  showScreen('screen-main-choice');
});

/* =========================================================
   ОНЛАЙН-МУЛЬТИПЛЕЕР ЧЕРЕЗ FIREBASE
   ========================================================= */
function makePlayerId(){
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function refreshOnlineRoomOccupancyBadges(){
  ROOMS.forEach((room, idx) => {
    const badge = el('online-room-grid-occ-' + idx);
    if (!badge) return;
    database.ref(`${ROOMS_DB_PATH}/${ONLINE_ROOMS_DB_PATH}/${idx}/players`).once('value').then(snap => {
      const players = snap.val() || {};
      const count = Object.keys(players).length;
      badge.textContent = count > 0 ? `● ${count}/2` : '';
    }).catch(() => {});
  });
}

function onOnlineRoomPicked(idx, room){
  state.room = room;
  joinOnlineRoom(idx);
}

async function joinOnlineRoom(idx){
  const playerId = makePlayerId();
  const roomRef = database.ref(`${ROOMS_DB_PATH}/${ONLINE_ROOMS_DB_PATH}/${idx}`);

  state.online.active = true;
  state.online.roomIndex = idx;
  state.online.playerId = playerId;
  state.online.roomRef = roomRef;

  el('online-setup-warning').textContent = '';
  el('waiting-title').textContent = 'Заходим в комнату №' + (idx+1) + '…';
  el('waiting-sub').textContent = 'Пусть друг зайдёт в ту же комнату';
  showScreen('screen-online-waiting');

  const playersRef = roomRef.child('players');

  playersRef.child(playerId).set({ joinedAt: firebase.database.ServerValue.TIMESTAMP })
    .catch(err => {
      el('online-setup-warning').classList.add('err');
      el('online-setup-warning').textContent = 'Не удалось подключиться к комнате: ' + err.message;
    });

  // при закрытии/уходе — убираем себя из комнаты
  playersRef.child(playerId).onDisconnect().remove();

  // слушаем список игроков, чтобы понять, когда нас двое
  const playersListener = playersRef.on('value', (snap) => {
    const players = snap.val() || {};
    const ids = Object.keys(players).sort((a,b) => (players[a].joinedAt||0) - (players[b].joinedAt||0));

    if (ids.length >= 2 && ids.includes(playerId)){
      // комната заполнена — определяем роли детерминированно через transaction,
      // случайно решая, кто из двух допрашивающий (чтобы роль не была предсказуемой).
      assignRolesIfNeeded(roomRef, ids).then((roles) => {
        if (!roles) return;
        const myRole = roles[playerId];
        if (!myRole) return;
        startOnlineMatch(roomRef, playerId, myRole, ids);
      });
    } else if (ids.length >= 2 && !ids.includes(playerId)){
      // комната заполнилась кем-то другим раньше нас (редкий race) — сообщаем и не входим
      el('waiting-sub').textContent = 'Комната уже занята двумя другими игроками — выбери другую.';
    }
  });

  state.online.unsubscribers.push(() => playersRef.off('value', playersListener));
}

// Гарантируем единственное присвоение ролей через transaction, чтобы оба клиента сошлись на одном результате.
function assignRolesIfNeeded(roomRef, ids){
  return roomRef.child('roles').transaction((current) => {
    if (current && current.assigned) return current; // уже назначено — не трогаем
    const shuffled = ids.slice(0, 2);
    const interrogatorFirst = Math.random() < 0.5;
    const roles = {};
    roles[shuffled[0]] = interrogatorFirst ? 'interrogator' : 'suspect';
    roles[shuffled[1]] = interrogatorFirst ? 'suspect' : 'interrogator';
    return { assigned: true, map: roles, commentaryOwner: shuffled[0] };
  }).then((result) => {
    const val = result.snapshot.val();
    return val ? val.map : null;
  }).catch((err) => {
    console.warn('Не удалось назначить роли транзакцией', err);
    return null;
  });
}

let onlineMatchStarted = false;

function startOnlineMatch(roomRef, playerId, myRole, ids){
  if (onlineMatchStarted) return;
  onlineMatchStarted = true;

  state.myRole = myRole;
  state.online.isInterrogator = myRole === 'interrogator';

  roomRef.child('roles/commentaryOwner').once('value').then(snap => {
    state.online.isCommentaryOwner = snap.val() === playerId;
  });

  // Кейс генерирует ТОЛЬКО допрашивающий клиент (он первый узнаёт роль детерминированно из той же transaction),
  // чтобы не было двух разных дел. Подозреваемый клиент ждёт публикации кейса.
  if (myRole === 'interrogator'){
    state.isGuilty = null; // будет решено внутри startCase() и опубликовано
    startCase();
  } else {
    el('waiting-title').textContent = 'Роли распределены — ты подозреваемый';
    el('waiting-sub').textContent = 'Допрашивающий готовит дело…';
    listenForOnlineCase(roomRef);
  }

  attachOnlineGameListeners(roomRef, playerId);
}

function listenForOnlineCase(roomRef){
  const caseListener = roomRef.child('case').on('value', (snap) => {
    const val = snap.val();
    if (val && val.caseData){
      state.caseData = val.caseData;
      state.isGuilty = val.isGuilty;
      state.matchDifficulty = val.difficulty ?? SETTINGS_DEFAULTS.aiDifficulty;
      state.matchMinWords = val.minWords ?? SETTINGS_DEFAULTS.replyMinWords;
      state.matchMaxWords = val.maxWords ?? SETTINGS_DEFAULTS.replyMaxWords;
      roomRef.child('case').off('value', caseListener);
      beginGameScreen();
    }
  });
  state.online.unsubscribers.push(() => roomRef.child('case').off('value', caseListener));
}

function publishOnlineCase(){
  if (!state.online.roomRef) return;
  state.online.roomRef.child('case').set({
    caseData: state.caseData,
    isGuilty: state.isGuilty,
    difficulty: state.ai.aiDifficulty,
    minWords: state.ai.replyMinWords,
    maxWords: state.ai.replyMaxWords
  }).catch(err => console.warn('Не удалось опубликовать дело в онлайн-комнату', err));
}

function attachOnlineGameListeners(roomRef, playerId){
  // сообщения чата — общий поток, каждый клиент дописывает свои, слушает все
  let lastSeenMsgKey = null;
  const chatListener = roomRef.child('chat').on('child_added', (snap) => {
    const msg = snap.val();
    if (!msg) return;
    // Своё сообщение уже отрисовано оптимистично при отправке (см. sendOnlineTurn) — не дублируем его.
    if (msg.author === playerId) return;
    addChatMessage(msg.role, msg.text, msg.tremor || null);
  });
  state.online.unsubscribers.push(() => roomRef.child('chat').off('child_added', chatListener));

  // жизни/статус
  const stateListener = roomRef.child('liveState').on('value', (snap) => {
    const live = snap.val();
    if (!live) return;
    if (typeof live.hearts === 'number'){
      state.hearts = live.hearts;
      updateHeartsUI();
    }
    if (live.ended && !state.ended){
      state.ended = true;
      state.releasedOrExecuted = live.outcome;
      state.surrendered = live.outcome === 'surrendered';
      finishOnlineLocally(live.outcome);
    }
  });
  state.online.unsubscribers.push(() => roomRef.child('liveState').off('value', stateListener));

  // комментаторы рефери — только не-владелец слушает чужие, владелец рисует свои локально и пушит
  const commentaryListener = roomRef.child('commentary').on('child_added', (snap) => {
    const c = snap.val();
    if (!c) return;
    if (c.author === playerId) return; // свои уже отрисованы локально
    addCommentaryBubble(c.side, c.text);
  });
  state.online.unsubscribers.push(() => roomRef.child('commentary').off('child_added', commentaryListener));
}

function sendOnlineTurn(text){
  if (!state.online.roomRef) return;
  const role = state.myRole === 'interrogator' ? 'interrogator' : 'suspect';
  // оптимистично рисуем локально сразу
  addChatMessage(role, text);
  state.online.roomRef.child('chat').push({
    role, text, author: state.online.playerId, ts: firebase.database.ServerValue.TIMESTAMP
  }).catch(err => addSystemMessage('Не удалось отправить сообщение: ' + err.message));
}

function pushOnlineCommentary(side, text){
  if (!state.online.roomRef) return;
  state.online.roomRef.child('commentary').push({
    side, text, author: state.online.playerId
  }).catch(() => {});
}

function onlineApplyTorture(){
  if (state.myRole !== 'interrogator') return;
  const newHearts = state.hearts - 1;
  state.hearts = newHearts;
  updateHeartsUI();
  addSystemMessage(`Пытка применена. Осталось жизней: ${newHearts}.`);
  state.online.roomRef.child('liveState').update({ hearts: newHearts }).catch(() => {});
  if (newHearts <= 0){
    endGame('executed');
  }
}

function onlineApplyRelease(){
  if (state.myRole !== 'interrogator') return;
  endGame('released');
}

function onlineSurrender(){
  if (state.myRole !== 'suspect' || !state.isGuilty) return;
  state.surrendered = true;
  endGame('surrendered');
}

function publishOnlineEnd(outcome){
  if (!state.online.roomRef) return;
  state.online.roomRef.child('liveState').update({
    ended: true, outcome, hearts: state.hearts
  }).catch(() => {});
}

function finishOnlineLocally(outcome){
  clearInterval(state.timerInterval);
  clearInterval(state.commentaryInterval);
  el('btn-torture').disabled = true;
  el('btn-release').disabled = true;
  el('btn-surrender').disabled = true;
  el('chat-input').disabled = true;
  el('btn-send').disabled = true;

  // Второй клиент (не инициатор конца) тоже должен показать тот же вердикт —
  // переиспользуем ту же процедуру генерации комментария рефери локально.
  endGameLocalEcho(outcome);
}

async function endGameLocalEcho(outcome){
  const elapsedSec = Math.floor((Date.now() - state.startTime) / 1000);
  const treatedAsExecuted = outcome === 'executed' || outcome === 'surrendered';
  const wasCorrect = (treatedAsExecuted && state.isGuilty) || (outcome === 'released' && !state.isGuilty);
  showVerdictLoading();
  try {
    const comment = await callAI(state.ai.modelVerdict, state.ai.apiKey, [
      { role:'system', content: 'Дай очень короткую (1 предложение) справедливую реплику для второго игрока о том, что раунд завершён вердиктом другого игрока. Без markdown.' },
      { role:'user', content: 'Раунд закрыт, исход: ' + outcome }
    ], 60).catch(() => 'Дело закрыто — детали смотри у другого игрока.');
    showVerdict(outcome, wasCorrect, comment, elapsedSec);
  } catch(e){
    showVerdict(outcome, wasCorrect, 'Дело закрыто.', elapsedSec);
  }
}

function leaveOnlineRoomIfAny(){
  if (!state.online.active) return;
  state.online.unsubscribers.forEach(fn => { try { fn(); } catch(e){} });
  state.online.unsubscribers = [];
  if (state.online.roomRef && state.online.playerId){
    state.online.roomRef.child('players').child(state.online.playerId).remove().catch(() => {});
  }
  state.online.active = false;
  state.online.roomIndex = null;
  state.online.roomRef = null;
  onlineMatchStarted = false;
}

el('btn-cancel-wait').addEventListener('click', () => {
  leaveOnlineRoomIfAny();
  showScreen('screen-online-setup');
  refreshOnlineRoomOccupancyBadges();
});
