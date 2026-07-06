/* ==========================================================================
   КУЗНИЦА КЛИНКОВ — game.js
   Realtime-дуэль мечей на Firebase Realtime Database.

   Структура БД:
   /rooms/{roomId}/
       players/{playerId} = { name, joinedAt }
       settings          = { mode, coinBudget, turnTimerSec, bestOf, rematchVotes:{} }
       round/{n}/
           submissions/{playerId} = { type:'freeform'|'market', text?, purchases?, ready:true, submittedAt }
           result = { stats:{a,b}, epithets:{a,b}, flavors:{a,b}, verdictText, winnerId, crit, generatedAt }
       score/{playerId} = number
       currentRound = n
       history/{n} = { winnerId, mode }
       typing/{playerId} = timestamp   (индикатор "печатает")

   ИИ-вызов делегирован во второй файл (ai-config.html), который пишет
   ключ/промпт/модель в localStorage. Если он не настроен — используется
   локальный резервный "ИИ" (детерминированный на основе текста/покупок),
   чтобы игра работала даже без настройки внешнего API.
   ========================================================================== */

(function(){
"use strict";

/* ---------------------------- Firebase init ---------------------------- */
const firebaseConfig = { databaseURL: "https://messengerb-dcc80-default-rtdb.europe-west1.firebasedatabase.app" };
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

/* ---------------------------- Константы --------------------------------- */
const ROOM_COUNT = 9;
const TRAITS = [
  { key:'sharp',  name:'Острота',  desc:'Пробивная сила удара, урон по броне', cost:[0,1,2,3,5,7,10], icon:'sharp' },
  { key:'size',   name:'Размер',   desc:'Досягаемость и вес клинка',            cost:[0,1,2,4,6,8,11], icon:'size' },
  { key:'light',  name:'Лёгкость', desc:'Скорость взмаха и число ударов',       cost:[0,1,2,3,5,7,10], icon:'light' },
  { key:'balance',name:'Баланс',   desc:'Точность и устойчивость в бою',        cost:[0,1,2,3,4,6,9],  icon:'balance' },
  { key:'guard',  name:'Защита',   desc:'Способность парировать удар',          cost:[0,1,2,3,5,7,10], icon:'guard' },
  { key:'rune',   name:'Руны',     desc:'Редкий магический бонус, макс. 2 очка', cost:[0,4,9], icon:'rune', max:2, isRune:true },
];
const DEFAULT_COIN_BUDGET = 10;
const DEFAULT_TURN_TIMER = 120; // сек, 0 = без таймера
const CHARS_PER_COIN = 10; // "Кузница слов": 1 монета = 10 букв лимита (30 монет = 300 букв)
const MIN_FREEFORM_CHARS = 12;
const MAX_FREEFORM_CHARS_CAP = 2000; // защитный потолок на случай огромного бюджета монет
const SOUND_KEY = 'kk_sound_on';
const NAME_KEY = 'kk_player_name';
const PID_KEY = 'kk_player_id';

/* ---------------------------- Состояние клиента -------------------------- */
const state = {
  myName: localStorage.getItem(NAME_KEY) || '',
  myId: localStorage.getItem(PID_KEY) || null,
  currentRoom: null,
  roomRef: null,
  settings: null,
  players: {},
  selectedMode: null,
  purchases: {}, // trait.key -> level index
  listeners: [],
  round: 1,
  lastRenderedResultRound: null,
  soundOn: localStorage.getItem(SOUND_KEY) !== 'off',
};

if (!state.myId) {
  state.myId = 'p_' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem(PID_KEY, state.myId);
}

/* ---------------------------- Утилиты ------------------------------------ */
function $(sel){ return document.querySelector(sel); }
function $all(sel){ return Array.from(document.querySelectorAll(sel)); }
function show(screenId){
  $all('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) el.classList.add('active');
}
function toast(msg, ms=3200){
  const wrap = $('#toast-wrap');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(), 320); }, ms);
}
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function seededRandom(seedStr){
  let h = 1779033703 ^ seedStr.length;
  for (let i=0;i<seedStr.length;i++){
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function(){
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
function playSound(kind){
  if (!state.soundOn) return;
  try{
    const ctx = playSound._ctx || (playSound._ctx = new (window.AudioContext||window.webkitAudioContext)());
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    const map = {
      clang:  {f:[180,90], t:0.28, type:'square', vol:0.12},
      forge:  {f:[420,220], t:0.4, type:'sawtooth', vol:0.07},
      win:    {f:[440,880], t:0.5, type:'triangle', vol:0.1},
      click:  {f:[600,600], t:0.06, type:'sine', vol:0.05},
    };
    const m = map[kind] || map.click;
    o.type = m.type;
    o.frequency.setValueAtTime(m.f[0], ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(40,m.f[1]), ctx.currentTime + m.t);
    g.gain.setValueAtTime(m.vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + m.t);
    o.start(); o.stop(ctx.currentTime + m.t + 0.02);
  }catch(e){ /* audio not available */ }
}

/* ---------------------------- Header / connection ------------------------ */
db.ref('.info/connected').on('value', snap=>{
  const connected = snap.val();
  $('#conn-text').textContent = connected ? 'соединение с наковальней' : 'обрыв связи…';
  $('#conn-chip').classList.toggle('live', !!connected);
});

$('#sound-toggle-btn').addEventListener('click', ()=>{
  state.soundOn = !state.soundOn;
  localStorage.setItem(SOUND_KEY, state.soundOn ? 'on':'off');
  $('#sound-toggle-btn').textContent = state.soundOn ? '🔊' : '🔇';
  toast(state.soundOn ? 'Звук включён' : 'Звук выключен');
});
$('#sound-toggle-btn').textContent = state.soundOn ? '🔊' : '🔇';

/* ---------------------------- Name gate ---------------------------------- */
function initNameGate(){
  const input = $('#input-name');
  input.value = state.myName;
  if (state.myName){
    enterHome();
    return;
  }
  show('screen-gate');
  input.focus();
  const commit = ()=>{
    const v = input.value.trim();
    if (!v){ toast('Имя не может быть пустым.'); input.focus(); return; }
    state.myName = v.slice(0,18);
    localStorage.setItem(NAME_KEY, state.myName);
    enterHome();
  };
  $('#btn-enter-forge').addEventListener('click', commit);
  input.addEventListener('keydown', e=>{ if (e.key==='Enter') commit(); });
}

function enterHome(){
  $('#me-chip').style.display = 'inline-flex';
  $('#me-name-label').textContent = state.myName;
  show('screen-home');
  renderRoomsList();
}

/* ---------------------------- Rooms list ---------------------------------- */
function renderRoomsList(){
  const grid = $('#rooms-grid');
  grid.innerHTML = '';
  for (let i=1;i<=ROOM_COUNT;i++){
    const card = document.createElement('div');
    card.className = 'panel room-card empty';
    card.dataset.room = i;
    card.innerHTML = `
      <div class="room-num">№${i}</div>
      <div class="room-state">Наковальня свободна</div>
      <div class="room-players"></div>
    `;
    card.addEventListener('click', ()=> joinRoom(i));
    grid.appendChild(card);
  }
  // Подписка на список игроков всех комнат разом, для живого превью
  db.ref('rooms').off('value');
  db.ref('rooms').on('value', snap=>{
    const data = snap.val() || {};
    let totalOnline = 0;
    for (let i=1;i<=ROOM_COUNT;i++){
      const card = grid.querySelector(`.room-card[data-room="${i}"]`);
      if (!card) continue;
      const room = data[i] || {};
      const players = room.players || {};
      const names = Object.values(players).map(p=>p.name);
      totalOnline += names.length;
      const stateEl = card.querySelector('.room-state');
      const playersEl = card.querySelector('.room-players');
      playersEl.innerHTML = names.map(n=>`<span class="player-pill">${escapeHtml(n)}</span>`).join('');
      card.classList.remove('empty','full','mine');
      if (names.length === 0){
        stateEl.textContent = 'Наковальня свободна';
        card.classList.add('empty');
      } else if (names.length === 1){
        stateEl.textContent = '1 кузнец ждёт соперника';
        if (players[state.myId]) card.classList.add('mine');
      } else {
        stateEl.textContent = `Бой идёт (${names.length} чел.)`;
        card.classList.add('full');
        if (players[state.myId]) card.classList.add('mine');
      }
    }
    $('#rooms-online-count').textContent = totalOnline;
  });

  // check URL param for direct room link
  const params = new URLSearchParams(location.search);
  const r = parseInt(params.get('room'));
  if (r && r>=1 && r<=ROOM_COUNT){
    setTimeout(()=>joinRoom(r), 300);
  }
}

/* ---------------------------- Join / leave room ---------------------------- */
function joinRoom(roomId){
  detachRoomListeners();
  state.currentRoom = roomId;
  state.roomRef = db.ref('rooms/' + roomId);

  // Максимум двое бойцов. Третий и далее входят как наблюдатели —
  // они видят лобби и дуэли, но не пишутся в /players и не участвуют в бою.
  state.roomRef.child('players').once('value').then(snap=>{
    const players = snap.val() || {};
    const ids = Object.keys(players);
    const isAlreadyPlayer = !!players[state.myId];
    state.isSpectator = (ids.length >= 2 && !isAlreadyPlayer);

    // БАГФИКС: если наковальня сейчас пуста (последние бойцы вышли/отключились),
    // в БД мог остаться "хвост" от прошлого матча — round/{n}/result с winnerId,
    // currentRound, score и history. Раньше leaveRoom() удалял только players/{id},
    // не трогая эти поля. Из-за этого первый же новый игрок, заходящий в опустевшую
    // комнату, наследовал старый round/{n}/result. Как только заходил второй игрок,
    // handleRoundUpdate() у обоих клиентов видел уже существующий r.result — и игру
    // сразу кидало на экран победителя, минуя лобби и сам раунд. Поэтому при входе
    // в ПУСТУЮ комнату сбрасываем игровые данные раунда, прежде чем стать первым игроком.
    const resetIfEmpty = (ids.length === 0)
      ? Promise.all([
          state.roomRef.child('round').remove(),
          state.roomRef.child('currentRound').remove(),
          state.roomRef.child('score').remove(),
          state.roomRef.child('history').remove(),
        ])
      : Promise.resolve();

    resetIfEmpty.then(()=>{
      if (state.isSpectator){
        toast('В этой наковальне уже двое кузнецов. Вы вошли как наблюдатель.');
        state.roomRef.child('spectators/' + state.myId).set({ name: state.myName });
        state.roomRef.child('spectators/' + state.myId).onDisconnect().remove();
      } else {
        const myRef = state.roomRef.child('players/' + state.myId);
        myRef.set({ name: state.myName, joinedAt: firebase.database.ServerValue.TIMESTAMP });
        myRef.onDisconnect().remove();
      }

      history.replaceState(null, '', '?room=' + roomId);
      $('#lobby-room-label').textContent = 'Комната №' + roomId + (state.isSpectator ? ' · наблюдатель' : '');
      const aiLink = $('#ai-config-link');
      if (aiLink) aiLink.href = 'ai-config.html?room=' + roomId;
      attachRoomListeners();
      show('screen-lobby');
      applySpectatorRestrictions();
    });
  });
}

function applySpectatorRestrictions(){
  // Наблюдатель может смотреть лобби и дуэли, но не может выбирать режим,
  // менять настройки и отправлять свой меч.
  const lockBtn = $('#btn-lock-mode');
  if (state.isSpectator){
    lockBtn.disabled = true;
    lockBtn.title = 'Наблюдатели не участвуют в бою';
    $('#mode-card-freeform').style.pointerEvents = 'none';
    $('#mode-card-market').style.pointerEvents = 'none';
    $('#mode-card-freeform').style.opacity = '0.6';
    $('#mode-card-market').style.opacity = '0.6';
  }
}

function leaveRoom(){
  if (state.roomRef){
    const ref = state.roomRef;
    ref.child('players/' + state.myId).remove()
      .then(()=> ref.child('players').once('value'))
      .then(snap=>{
        // Если после моего выхода в комнате не осталось игроков — сразу подчищаем
        // "хвост" прошлого матча (round/currentRound/score/history). Это дублирует
        // защиту в joinRoom() (там сброс идёт при входе в пустую комнату), но делает
        // очистку менее отложенной и подчищает данные, даже если следующим зайдёт
        // наблюдатель, а не игрок.
        const remaining = snap.val() || {};
        if (Object.keys(remaining).length === 0){
          ref.child('round').remove();
          ref.child('currentRound').remove();
          ref.child('score').remove();
          ref.child('history').remove();
        }
      });
    state.roomRef.child('spectators/' + state.myId).remove();
  }
  detachRoomListeners();
  state.currentRoom = null;
  state.roomRef = null;
  state.isSpectator = false;
  state.currentRoundSubs = null;
  battleIntroShownForRound = null;
  history.replaceState(null, '', location.pathname);
  enterHome();
}

function detachRoomListeners(){
  if (state.roomRef){
    state.roomRef.off();
    state.roomRef.child('aiSettings').off();
  }
  state.listeners = [];
  aiConfigCache = null;
  latestRoundSnapshotData = null;
}

/* ---------------------------- Settings defaults --------------------------- */
function ensureSettingsExist(){
  state.roomRef.child('settings').once('value').then(snap=>{
    if (!snap.exists()){
      state.roomRef.child('settings').set({
        mode: null,
        coinBudget: DEFAULT_COIN_BUDGET,
        turnTimerSec: DEFAULT_TURN_TIMER,
        bestOf: 3,
        hostId: state.myId,
        allowRunes: true,
      });
    }
  });
}

/* ---------------------------- Room listeners ------------------------------- */
let latestRoundSnapshotData = null; // последний сырой снимок /round, чтобы пересчитать при смене currentRound
function attachRoomListeners(){
  ensureSettingsExist();
  attachAiSettingsListener();

  state.roomRef.child('players').on('value', snap=>{
    state.players = snap.val() || {};
    renderLobbyPlayers();
  });

  state.roomRef.child('settings').on('value', snap=>{
    state.settings = snap.val() || {};
    renderSettingsPanel();
    renderModePicker();
  });

  state.roomRef.child('score').on('value', snap=>{
    renderScoreStrip(snap.val() || {});
  });

  state.roomRef.child('history').on('value', snap=>{
    renderHistory(snap.val() || {});
  });

  // ВАЖНО: currentRound и round читаются в разные моменты (Firebase не гарантирует
  // порядок между листенерами на разных путях). Если бы round-листенер сработал раньше
  // currentRound, state.round ещё содержал бы старое/дефолтное значение (например, 1),
  // и handleRoundUpdate мог бы найти там результат прошлого раунда и ошибочно показать
  // экран дуэли новому игроку, зашедшему уже в разгаре следующего раунда, у которого
  // ещё не был обновлён state.round. Поэтому пересчитываем round при КАЖДОМ изменении
  // currentRound, используя последний известный снимок /round, а не полагаемся на порядок.
  state.roomRef.child('currentRound').on('value', snap=>{
    state.round = snap.val() || 1;
    handleRoundUpdate(latestRoundSnapshotData || {});
  });

  state.roomRef.child('round').on('value', snap=>{
    latestRoundSnapshotData = snap.val() || {};
    handleRoundUpdate(latestRoundSnapshotData);
  });

  state.roomRef.child('typing').on('value', snap=>{
    renderOpponentTyping(snap.val() || {});
  });

  state.roomRef.child('spectators').on('value', snap=>{
    const spectators = snap.val() || {};
    const count = Object.keys(spectators).length;
    $('#spectator-chip').style.display = count > 0 ? 'inline-flex' : 'none';
    $('#spectator-count').textContent = count;
  });
}

function renderOpponentTyping(typingObj){
  const oppId = otherPlayerId();
  const oppTyping = oppId && typingObj[oppId] && (Date.now() - typingObj[oppId] < 3000);
  const text = oppTyping ? `✒ ${escapeHtml(playerName(oppId))} куёт меч прямо сейчас…` : '';
  const a = document.getElementById('freeform-opponent-indicator');
  const b = document.getElementById('waiting-typing-indicator');
  if (a) a.textContent = text;
  if (b) b.textContent = text;
}

/* ---------------------------- Lobby: players & readiness -------------------- */
function otherPlayerId(){
  return Object.keys(state.players).find(id => id !== state.myId) || null;
}
function playerName(id){
  return (state.players[id] && state.players[id].name) || '???';
}

function renderLobbyPlayers(){
  const wrap = $('#lobby-players');
  const ids = Object.keys(state.players);
  wrap.innerHTML = '';
  if (ids.length === 0){
    wrap.innerHTML = '<span class="small-muted">Наковальня пуста.</span>';
  }
  ids.forEach(id=>{
    const el = document.createElement('div');
    el.className = 'player-status waiting';
    el.innerHTML = `<span class="st-dot"></span> ${escapeHtml(playerName(id))}${id===state.myId ? ' (вы)' : ''}`;
    wrap.appendChild(el);
  });
  if (ids.length < 2){
    const el = document.createElement('div');
    el.className = 'player-status';
    el.innerHTML = `<span class="st-dot"></span> ждём второго кузнеца…`;
    wrap.appendChild(el);
  }
  updateLockButtonState();
}

function renderScoreStrip(scoreObj){
  const strip = $('#lobby-score');
  const ids = Object.keys(state.players);
  strip.innerHTML = '';
  ids.forEach(id=>{
    const box = document.createElement('div');
    box.className = 'score-box';
    box.innerHTML = `<div class="n">${scoreObj[id]||0}</div><div class="l">${escapeHtml(playerName(id))}</div>`;
    strip.appendChild(box);
  });
  if (ids.length===0){
    strip.innerHTML = '<span class="small-muted">Счёт появится после первой дуэли.</span>';
  }
  state.lastScore = scoreObj;
}

/* ---------------------------- Settings panel (host-editable) ---------------- */
function isHost(){
  return state.settings && state.settings.hostId === state.myId;
}
function renderSettingsPanel(){
  const s = state.settings || {};
  const host = isHost();
  const list = $('#settings-list');
  list.innerHTML = '';

  // Timer setting
  const timerRow = document.createElement('div');
  timerRow.className = 'settings-row';
  timerRow.innerHTML = `
    <div><div class="s-label">Таймер на ход</div><div class="s-desc">Сколько секунд даётся на ковку меча</div></div>
    <div class="segmented" id="timer-segmented"></div>
  `;
  list.appendChild(timerRow);
  const timerOptions = [ [0,'∞'], [60,'60с'], [120,'120с'], [180,'180с'] ];
  const seg = timerRow.querySelector('#timer-segmented');
  timerOptions.forEach(([val,label])=>{
    const b = document.createElement('button');
    b.textContent = label;
    b.className = (s.turnTimerSec===val || (!s.turnTimerSec && val===DEFAULT_TURN_TIMER)) ? 'active':'';
    b.disabled = !host;
    b.addEventListener('click', ()=>{ if(host) state.roomRef.child('settings/turnTimerSec').set(val); });
    seg.appendChild(b);
  });

  // Coin budget
  const coinRow = document.createElement('div');
  coinRow.className = 'settings-row';
  const budget = s.coinBudget || DEFAULT_COIN_BUDGET;
  coinRow.innerHTML = `
    <div><div class="s-label">Бюджет монет (режим торга)</div><div class="s-desc">Сколько монет получает каждый кузнец на меч</div></div>
    <div class="stepper">
      <button id="coin-minus">−</button><span class="val">${budget}</span><button id="coin-plus">+</button>
    </div>
  `;
  list.appendChild(coinRow);
  coinRow.querySelector('#coin-minus').addEventListener('click', ()=>{ if(host) state.roomRef.child('settings/coinBudget').set(clamp(budget-2,4,30)); });
  coinRow.querySelector('#coin-plus').addEventListener('click', ()=>{ if(host) state.roomRef.child('settings/coinBudget').set(clamp(budget+2,4,30)); });
  if (!host){ coinRow.querySelectorAll('button').forEach(b=>b.disabled=true); }

  // Best of
  const boRow = document.createElement('div');
  boRow.className = 'settings-row';
  const bo = s.bestOf || 3;
  boRow.innerHTML = `
    <div><div class="s-label">Формат матча</div><div class="s-desc">До скольки побед идёт очная встреча</div></div>
    <div class="segmented" id="bo-segmented"></div>
  `;
  list.appendChild(boRow);
  [1,3,5].forEach(val=>{
    const b = document.createElement('button');
    b.textContent = 'до ' + val;
    b.className = (bo===val) ? 'active':'';
    b.disabled = !host;
    b.addEventListener('click', ()=>{ if(host) state.roomRef.child('settings/bestOf').set(val); });
    boRow.querySelector('#bo-segmented').appendChild(b);
  });

  // Runes toggle
  const runeRow = document.createElement('div');
  runeRow.className = 'settings-row';
  runeRow.innerHTML = `
    <div><div class="s-label">Руны в торге монет</div><div class="s-desc">Разрешить редкий магический бонус за монеты</div></div>
    <label class="toggle"><input type="checkbox" id="rune-toggle" ${s.allowRunes!==false?'checked':''} ${host?'':'disabled'}><span class="track"></span></label>
  `;
  list.appendChild(runeRow);
  runeRow.querySelector('#rune-toggle').addEventListener('change', e=>{ if(host) state.roomRef.child('settings/allowRunes').set(e.target.checked); });

  $('#host-note').textContent = host
    ? 'Вы хозяин наковальни — только вы можете менять правила.'
    : 'Правила меняет хозяин наковальни (тот, кто зашёл первым).';
}

/* ---------------------------- Mode picker ------------------------------------ */
function renderModePicker(){
  const mode = state.settings && state.settings.mode;
  $('#mode-card-freeform').classList.toggle('selected', mode==='freeform');
  $('#mode-card-market').classList.toggle('selected', mode==='market');
  updateLockButtonState();
}
$('#mode-card-freeform').addEventListener('click', ()=> proposeMode('freeform'));
$('#mode-card-market').addEventListener('click', ()=> proposeMode('market'));

function proposeMode(mode){
  if (!state.roomRef) return;
  state.roomRef.child('settings/mode').set(mode);
  playSound('click');
}

function updateLockButtonState(){
  const ids = Object.keys(state.players);
  const mode = state.settings && state.settings.mode;
  const btn = $('#btn-lock-mode');
  const line = $('#ready-status-line');
  if (ids.length < 2){
    btn.disabled = true;
    line.textContent = 'Нужно двое кузнецов в наковальне, чтобы начать.';
  } else if (!mode){
    btn.disabled = true;
    line.textContent = 'Выберите режим дуэли — решение видит соперник.';
  } else {
    btn.disabled = false;
    line.textContent = 'Режим выбран: ' + (mode==='freeform' ? 'Кузница слов' : 'Торг монет') + '. Оба готовы начать ковку.';
  }
}

$('#btn-lock-mode').addEventListener('click', ()=>{
  const mode = state.settings.mode;
  goToForgeScreen(mode);
});

function freeformCharLimit(){
  const coins = budget();
  return clamp(coins * CHARS_PER_COIN, 40, MAX_FREEFORM_CHARS_CAP);
}

function goToForgeScreen(mode){
  playSound('forge');
  if (mode === 'freeform'){
    const limit = freeformCharLimit();
    const area = $('#sword-desc');
    area.value = '';
    area.setAttribute('maxlength', String(limit));
    $('#desc-count').textContent = '0';
    $('#desc-max').textContent = String(limit);
    const coins = budget();
    $('#freeform-coin-rate').textContent = `${coins} монет = ${limit} букв`;
    show('screen-forge-freeform');
  } else {
    state.purchases = {};
    TRAITS.forEach(t=> state.purchases[t.key] = 0);
    renderMarket();
    show('screen-market');
  }
  startTimerIfNeeded();
}

/* ---------------------------- Lobby nav buttons ------------------------------ */
$('#btn-leave-room').addEventListener('click', leaveRoom);
$('#btn-copy-room').addEventListener('click', ()=>{
  const url = location.origin + location.pathname + '?room=' + state.currentRoom;
  navigator.clipboard?.writeText(url).then(()=> toast('Ссылка на комнату скопирована')).catch(()=>{
    prompt('Скопируйте ссылку:', url);
  });
});
$('#btn-how').addEventListener('click', ()=>{
  openModal('Как это работает',
    `1. Выберите комнату вместе с другом (максимум двое сражаются).<br>
     2. Выберите режим: описываете меч словами (длина текста ограничена монетами кузницы — например, 30 монет = 300 букв), или покупаете свойства за монеты напрямую.<br>
     3. Каждый вводит свои данные — соперник их не видит, пока оба не закончат.<br>
     4. ИИ-кузнец переплавляет данные в характеристики и пишет вердикт, опираясь на детали ОБОИХ мечей.<br>
     5. Перед результатом — короткая сцена столкновения клинков, а затем сам результат: характеристики, вердикт и то, что каждый игрок написал или купил.<br>
     6. Есть шанс критического удара, ничьи и серии побед.`,
    [{label:'Понятно', primary:true, action:closeModal}]);
});

/* ---------------------------- Text input screen (mode 1) --------------------- */
const descArea = $('#sword-desc');
descArea.addEventListener('input', ()=>{
  $('#desc-count').textContent = descArea.value.length;
  broadcastTyping();
});
$all('.trait-hint-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const hint = btn.dataset.hint;
    if (!descArea.value.includes(hint)){
      descArea.value += (descArea.value.trim().length ? '\n' : '') + hint;
      descArea.dispatchEvent(new Event('input'));
      descArea.focus();
    }
  });
});

let typingTimeout = null;
function broadcastTyping(){
  if (!state.roomRef) return;
  state.roomRef.child('typing/' + state.myId).set(Date.now());
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(()=> state.roomRef.child('typing/' + state.myId).remove(), 2500);
}

$('#btn-submit-freeform').addEventListener('click', ()=>{
  const text = descArea.value.trim();
  if (text.length < MIN_FREEFORM_CHARS){
    toast(`Опишите меч чуть подробнее (минимум ${MIN_FREEFORM_CHARS} символов).`);
    return;
  }
  const limit = freeformCharLimit();
  submitEntry({ type:'freeform', text: text.slice(0, limit) });
});

/* ---------------------------- Market screen (mode 2) -------------------------- */
function iconSvg(key){
  const icons = {
    sharp: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 20 L18 6 L20 4 L20 8 L8 20 Z" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`,
    size: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12 H20 M16 8 L20 12 L16 16 M8 8 L4 12 L8 16" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    light: `<svg viewBox="0 0 24 24" fill="none"><path d="M13 2 L5 14 H11 L9 22 L19 9 H13 Z" stroke="currentColor" stroke-width="1.4" fill="currentColor" fill-opacity="0.15"/></svg>`,
    balance: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3 V21 M5 8 H19 M5 8 L3 13 H7 L5 8 Z M19 8 L17 13 H21 L19 8 Z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>`,
    guard: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2 L20 6 V12 C20 17 16.5 20.5 12 22 C7.5 20.5 4 17 4 12 V6 Z" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>`,
    rune: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2 L14 9 L21 9 L15.5 13.5 L17.5 21 L12 16.5 L6.5 21 L8.5 13.5 L3 9 L10 9 Z" stroke="currentColor" stroke-width="1.2" fill="currentColor" fill-opacity="0.12"/></svg>`,
  };
  return icons[key] || '';
}

function traitCostToNext(trait){
  const level = state.purchases[trait.key] || 0;
  if (level >= trait.cost.length - 1) return null;
  return trait.cost[level+1] - trait.cost[level];
}
function totalSpent(){
  return TRAITS.reduce((sum,t)=> sum + (t.cost[state.purchases[t.key]||0] || 0), 0);
}
function budget(){ return (state.settings && state.settings.coinBudget) || DEFAULT_COIN_BUDGET; }

function renderMarket(){
  const grid = $('#market-grid');
  grid.innerHTML = '';
  const allowRunes = !(state.settings && state.settings.allowRunes===false);
  TRAITS.forEach(trait=>{
    if (trait.isRune && !allowRunes) return;
    const level = state.purchases[trait.key] || 0;
    const maxLevel = trait.max ? trait.max : trait.cost.length - 1;
    const row = document.createElement('div');
    row.className = 'panel trait-row';
    row.innerHTML = `
      <div class="trait-icon">${iconSvg(trait.icon)}</div>
      <div class="trait-info">
        <div class="t-name">${trait.name}</div>
        <div class="t-desc">${trait.desc}</div>
        <div class="trait-bar-wrap" data-pips></div>
      </div>
      <div class="trait-buy">
        <button class="stepper button" data-action="minus">−</button>
        <span class="trait-cost" data-cost></span>
        <button class="stepper button" data-action="plus">+</button>
      </div>
    `;
    grid.appendChild(row);
    renderPips(row, trait, level, maxLevel);
    updateCostLabel(row, trait);
    row.querySelector('[data-action="minus"]').addEventListener('click', ()=> adjustTrait(trait, -1));
    row.querySelector('[data-action="plus"]').addEventListener('click', ()=> adjustTrait(trait, +1));
  });
  updateWalletDisplay();
}
function renderPips(row, trait, level, maxLevel){
  const wrap = row.querySelector('[data-pips]');
  wrap.innerHTML = '';
  for (let i=1;i<=maxLevel;i++){
    const pip = document.createElement('div');
    pip.className = 'trait-pip' + (i<=level?' filled':'') + (trait.isRune?' rune':'');
    wrap.appendChild(pip);
  }
}
function updateCostLabel(row, trait){
  const next = traitCostToNext(trait);
  row.querySelector('[data-cost]').textContent = next===null ? 'макс' : ('+' + next + '₪');
}
function adjustTrait(trait, dir){
  const level = state.purchases[trait.key] || 0;
  const maxLevel = trait.max ? trait.max : trait.cost.length - 1;
  if (dir > 0){
    if (level >= maxLevel) { toast('Максимум по этому свойству достигнут.'); return; }
    const cost = trait.cost[level+1] - trait.cost[level];
    if (totalSpent() + cost > budget()){ toast('Не хватает монет в кошельке.'); return; }
    state.purchases[trait.key] = level + 1;
  } else {
    if (level <= 0) return;
    state.purchases[trait.key] = level - 1;
  }
  renderMarket();
  playSound('click');
}
function updateWalletDisplay(){
  $('#wallet-total').textContent = budget();
  $('#wallet-remaining').textContent = budget() - totalSpent();
}

$('#btn-submit-market').addEventListener('click', ()=>{
  if (totalSpent() === 0){
    toast('Распределите хотя бы немного монет.');
    return;
  }
  submitEntry({ type:'market', purchases: {...state.purchases}, spent: totalSpent() });
});

/* ---------------------------- Timer handling ---------------------------------- */
let activeTimerInterval = null;
function startTimerIfNeeded(){
  clearInterval(activeTimerInterval);
  const seconds = state.settings && state.settings.turnTimerSec;
  const noteEls = [$('#freeform-timer-note'), $('#market-timer-note')];
  if (!seconds){
    noteEls.forEach(el=> el && (el.textContent = 'Таймер отключён — куйте не торопясь.'));
    return;
  }
  let remaining = seconds;
  const tick = ()=>{
    noteEls.forEach(el=> el && (el.textContent = `⏳ Осталось ${remaining}с на ковку`));
    if (remaining <= 0){
      clearInterval(activeTimerInterval);
      // auto-submit whatever exists
      const activeScreen = document.querySelector('.screen.active').id;
      if (activeScreen === 'screen-forge-freeform' && descArea.value.trim().length >= MIN_FREEFORM_CHARS){
        submitEntry({ type:'freeform', text: descArea.value.trim().slice(0, freeformCharLimit()) });
      } else if (activeScreen === 'screen-market'){
        submitEntry({ type:'market', purchases: {...state.purchases}, spent: totalSpent() });
      } else if (activeScreen === 'screen-forge-freeform'){
        toast('Время вышло — меч остался незакалённым! Автопроигрыш раунда.');
        submitEntry({ type:'freeform', text: '(кузнец не успел выковать меч — заготовка осталась бесформенной)' , timedOut:true});
      }
    }
    remaining--;
  };
  tick();
  activeTimerInterval = setInterval(tick, 1000);
}

/* ---------------------------- Submission flow ----------------------------------- */
function submitEntry(payload){
  clearInterval(activeTimerInterval);
  const roundRef = state.roomRef.child('round/' + state.round + '/submissions/' + state.myId);
  roundRef.set({ ...payload, ready:true, submittedAt: firebase.database.ServerValue.TIMESTAMP });
  state.roomRef.child('typing/' + state.myId).remove();
  $('#waiting-title').textContent = 'Ваш меч готов';
  updateWaitingTextForOpponent();
  show('screen-waiting');
}

function updateWaitingTextForOpponent(){
  const oppId = otherPlayerId();
  const oppName = oppId ? playerName(oppId) : 'соперник';
  const oppSub = (state.currentRoundSubs || {})[oppId];
  if (oppSub && oppSub.ready){
    $('#waiting-text').textContent = `${oppName} уже закончил — сражение начинается…`;
  } else {
    $('#waiting-text').textContent = `${oppName} ещё куёт свой меч — как только закончит, схватка начнётся сама.`;
  }
}

/* ---------------------------- Round orchestration -------------------------------- */
let resolvingRound = false;
function handleRoundUpdate(roundData){
  const r = roundData[state.round];
  if (!r) return;
  const subs = r.submissions || {};
  state.currentRoundSubs = subs;
  const ids = Object.keys(state.players);
  if (ids.length < 2) return;

  const bothSubmitted = ids.every(id => subs[id] && subs[id].ready);

  // Если я уже отправил свой меч и сижу на экране ожидания — держим текст
  // в актуальном состоянии: показываем, куёт ли соперник ещё или уже закончил.
  if (document.getElementById('screen-waiting').classList.contains('active') && !r.result){
    updateWaitingTextForOpponent();
  }

  if (bothSubmitted && !r.result && !resolvingRound){
    // Only one client should compute — elect the "first" player id alphabetically to avoid double-write races
    const electedId = ids.slice().sort()[0];
    if (state.myId === electedId){
      resolvingRound = true;
      resolveDuel(ids, subs).finally(()=> resolvingRound = false);
    }
  }

  if (r.result){
    playBattleIntroThenResult(r.result, ids, subs);
  } else if (state.isSpectator && Object.keys(subs).length > 0){
    // наблюдатель видит, что ковка идёт, пока нет результата
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen && activeScreen.id === 'screen-lobby'){
      $('#waiting-title').textContent = 'Бой куётся';
      $('#waiting-text').textContent = 'Оба кузнеца работают над мечами — вы наблюдаете со стороны.';
      show('screen-waiting');
    }
  }
}

/* ---------------------------- AI bridge ------------------------------------------- */
// Конфиг ИИ настраивается вторым HTML-файлом (ai-config.html) и хранится ДВОЯКО:
//  1) в localStorage этого браузера (kk_ai_api_key/model/prompt) — быстрый локальный кеш;
//  2) в Firebase по пути /ai-settings/{roomId} — переживает смену устройства и браузера,
//     но автоматически считается просроченным через 2 суток (AI_SETTINGS_TTL_MS).
// game.js держит живую подписку на /ai-settings/{roomId} и обновляет локальный кеш
// каждый раз, когда запись в БД меняется (её могли сохранить с другого устройства).
const AI_SETTINGS_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 дня

let aiConfigCache = null; // { apiKey, model, prompt } | null пока не пришли данные из БД

function readLocalAiCache(){
  return {
    apiKey: localStorage.getItem('kk_ai_api_key') || '',
    model: localStorage.getItem('kk_ai_model') || '',
    prompt: localStorage.getItem('kk_ai_prompt') || '',
  };
}
function writeLocalAiCache(cfg){
  if (cfg.apiKey) localStorage.setItem('kk_ai_api_key', cfg.apiKey); else localStorage.removeItem('kk_ai_api_key');
  if (cfg.model) localStorage.setItem('kk_ai_model', cfg.model); else localStorage.removeItem('kk_ai_model');
  if (cfg.prompt) localStorage.setItem('kk_ai_prompt', cfg.prompt); else localStorage.removeItem('kk_ai_prompt');
}

function attachAiSettingsListener(){
  if (!state.roomRef) return;
  state.roomRef.child('aiSettings').on('value', snap=>{
    const remote = snap.val();
    const now = Date.now();
    if (remote && remote.expiresAt && remote.expiresAt > now && remote.apiKey && remote.model){
      // Свежая запись из БД — она главнее локального кеша (могла прийти с другого устройства)
      aiConfigCache = { apiKey: remote.apiKey, model: remote.model, prompt: remote.prompt || '' };
      writeLocalAiCache(aiConfigCache);
      updateAiStatusChip(true, remote.expiresAt);
    } else if (remote && remote.expiresAt && remote.expiresAt <= now){
      // Запись протухла (прошло 2 дня) — чистим за собой, откатываемся на локальный кеш/резерв
      state.roomRef.child('aiSettings').remove();
      aiConfigCache = readLocalAiCache();
      updateAiStatusChip(false, null);
    } else {
      // В БД ничего нет для этой комнаты — используем локальный кеш браузера как есть
      aiConfigCache = readLocalAiCache();
      updateAiStatusChip(!!(aiConfigCache.apiKey && aiConfigCache.model), null);
    }
  });
}

function updateAiStatusChip(active, expiresAt){
  const chip = document.getElementById('ai-status-chip');
  if (!chip) return;
  if (active){
    chip.style.display = 'inline-flex';
    chip.classList.add('live');
    const daysLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / (24*60*60*1000))) : null;
    chip.querySelector('span:last-child').textContent = daysLeft!==null ? `Дух кузницы активен · ещё ${daysLeft}д` : 'Дух кузницы активен (локально)';
  } else {
    chip.style.display = 'none';
  }
}

function getAiConfig(){
  return aiConfigCache || readLocalAiCache();
}

async function resolveDuel(ids, subs){
  const [idA, idB] = ids;
  const subA = subs[idA], subB = subs[idB];
  let forged;
  try{
    forged = await callAiForge(idA, subA, idB, subB);
  }catch(e){
    console.warn('AI forge failed, falling back to local resolver:', e);
    forged = localForge(idA, subA, idB, subB);
  }
  // Определяем победителя, учитывая крит-шанс "решающего удара" при близком счёте
  const scoreA = totalPower(forged.stats.a);
  const scoreB = totalPower(forged.stats.b);
  let winnerId, crit=false, verdictText=forged.verdictText;
  const diff = Math.abs(scoreA - scoreB);
  const rng = seededRandom(state.currentRoom + '-' + state.round + '-' + idA + idB);
  if (diff < 6){
    crit = true;
    const critRoll = rng();
    winnerId = critRoll < 0.5 ? idA : idB;
    verdictText += ' Клинки почти равны — исход решил один-единственный, непредсказуемый выпад.';
  } else {
    winnerId = scoreA > scoreB ? idA : idB;
  }

  const resultPayload = {
    stats: forged.stats,
    epithets: forged.epithets,
    flavors: forged.flavors,
    verdictText,
    winnerId,
    crit,
    idA, idB,
    generatedAt: firebase.database.ServerValue.TIMESTAMP,
  };
  await state.roomRef.child('round/' + state.round + '/result').set(resultPayload);
  // score + history
  const scoreRef = state.roomRef.child('score/' + winnerId);
  await scoreRef.transaction(v => (v||0) + 1);
  await state.roomRef.child('history/' + state.round).set({ winnerId, mode: subA.type });
}

function totalPower(stats){
  return stats.sharp + stats.size*0.8 + stats.light*0.9 + stats.guard*0.9 + stats.magic*1.1 + (stats.rare||0)*0.5;
}

/* ----- Внешний ИИ через Anthropic-совместимый эндпоинт, настроенный во втором файле ----- */
async function callAiForge(idA, subA, idB, subB){
  const cfg = getAiConfig();
  if (!cfg.apiKey || !cfg.model){
    throw new Error('AI not configured — using local forge');
  }
  const systemPrompt = (cfg.prompt || DEFAULT_AI_PROMPT);
  const userPayload = buildForgeUserPrompt(idA, subA, idB, subB);

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1600,
      messages: [
        { role:'system', content: systemPrompt },
        { role:'user', content: userPayload },
      ],
    }),
  });
  if (!resp.ok) throw new Error('AI HTTP ' + resp.status);
  const data = await resp.json();
  const msgContent = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!msgContent) throw new Error('No text in AI response');
  const cleaned = msgContent.replace(/```json|```/g,'').trim();
  const parsed = JSON.parse(cleaned);
  return normalizeAiForgeResult(parsed, idA, idB);
}

const DEFAULT_AI_PROMPT = `Ты — беспристрастный ИИ-кузнец в игре-дуэли мечей. Тебе дают описание(я) двух мечей (либо текстовое описание, либо распределение очков по свойствам: острота, размер, лёгкость, баланс, защита, руны). Твоя задача — присвоить каждому мечу 6 числовых характеристик от 0 до 100: sharp (острота/урон), size (размер/охват), light (лёгкость/скорость), balance (баланс/точность), guard (защита), magic (магическая сила). Также добавь rare (0-100, редкость/уникальность концепции). Будь справедлив и последователен: разные по силе описания должны получать разные оценки, но не завышай оба меча одинаково. Придумай короткий эпитет (2-4 слова) для каждого меча. Также напиши flavor — атмосферное описание меча из 2-3 предложений (примерно 30-45 слов): оно ДОЛЖНО явно отражать именно те характеристики, которые ты только что присвоил этому мечу — если sharp высокий, опиши остроту и то, как клинок режет; если magic высокий, опиши магическое свечение или силу рун; если guard низкий, упомяни лёгкую или почти отсутствующую защиту, и так далее для самых заметных (самых высоких и самых низких) характеристик. Не пиши обтекаемо — цифры и текст должны совпадать. Напиши краткий вердикт дуэли (verdictText, 2-4 предложения, художественно, без явного объявления победителя числами — это сделает игра). ВАЖНО: verdictText обязан явно опираться на КОНКРЕТНЫЕ детали ОБОИХ описаний — упомяни хотя бы одну деталь из меча A (материал, форму, магию или историю) и хотя бы одну деталь из меча B, и опиши, как именно эти конкретные свойства столкнулись друг с другом в бою (например, как одна деталь парировала, усилила или свела на нет другую). Не пиши общими фразами, которые подошли бы любому мечу. Ответь СТРОГО в формате JSON без пояснений и без markdown-разметки:
{"a":{"sharp":0,"size":0,"light":0,"balance":0,"guard":0,"magic":0,"rare":0,"epithet":"","flavor":""},"b":{...},"verdictText":""}`;

function buildForgeUserPrompt(idA, subA, idB, subB){
  const describe = (sub)=>{
    if (sub.type === 'freeform') return `Текстовое описание меча: "${sub.text}"`;
    const parts = TRAITS.map(t=>{
      const lvl = (sub.purchases && sub.purchases[t.key]) || 0;
      return `${t.name}: уровень ${lvl}`;
    });
    return `Меч собран через покупку свойств за монеты (потрачено ${sub.spent||0} монет). Уровни: ${parts.join(', ')}.`;
  };
  return `Меч игрока A ("${playerName(idA)}"):\n${describe(subA)}\n\nМеч игрока B ("${playerName(idB)}"):\n${describe(subB)}\n\nСгенерируй характеристики и вердикт согласно системному промпту. Напоминание: verdictText должен явно упомянуть конкретную деталь из описания меча A И конкретную деталь из описания меча B, показывая, как именно эти два конкретных свойства столкнулись в дуэли.`;
}

function normalizeAiForgeResult(parsed, idA, idB){
  const clampStat = v => clamp(Math.round(Number(v)||0), 0, 100);
  const norm = side => ({
    sharp: clampStat(side.sharp), size: clampStat(side.size), light: clampStat(side.light),
    balance: clampStat(side.balance), guard: clampStat(side.guard), magic: clampStat(side.magic),
    rare: clampStat(side.rare),
  });
  return {
    stats: { a: norm(parsed.a), b: norm(parsed.b) },
    epithets: { a: (parsed.a.epithet||'Безымянный клинок').slice(0,40), b: (parsed.b.epithet||'Безымянный клинок').slice(0,40) },
    flavors: { a: (parsed.a.flavor||'').slice(0,320), b: (parsed.b.flavor||'').slice(0,320) },
    verdictText: (parsed.verdictText || 'Клинки скрестились в тишине наковальни.').slice(0,400),
  };
}

/* ----- Локальный резервный "ИИ" (детерминированный от контента, без внешнего API) ----- */
function localForge(idA, subA, idB, subB){
  function scoreSubmission(sub, seedSuffix){
    const rng = seededRandom((sub.type==='freeform' ? sub.text : JSON.stringify(sub.purchases)) + seedSuffix);
    if (sub.type === 'market'){
      const lvl = key => ((sub.purchases||{})[key]||0);
      const maxOf = key => (TRAITS.find(t=>t.key===key).max || TRAITS.find(t=>t.key===key).cost.length-1);
      const pct = key => Math.round((lvl(key)/maxOf(key))*100);
      const marketStats = {
        sharp: pct('sharp'), size: pct('size'), light: pct('light'),
        balance: pct('balance'), guard: pct('guard'),
        magic: Math.round(pct('rune')*0.9 + rng()*8),
        rare: Math.round(pct('rune')*0.6 + rng()*15),
      };
      return {
        ...marketStats,
        epithet: pickEpithetFromLevels(sub.purchases, rng),
        flavor: buildStatFlavor(marketStats, rng),
      };
    }
    // freeform: naive keyword-weighted scoring + length/vividness bonus, deterministic via seeded rng
    const text = (sub.text||'').toLowerCase();
    const kw = {
      sharp:['остр','режущ','рассека','бритв','заточ','пронза'],
      size:['двуручн','огромн','длинн','тяжел','массивн','гигант'],
      light:['лёгк','легк','быстр','молние','гибк','тонк'],
      balance:['баланс','равновес','точн','выверен'],
      guard:['защит','крепк','щит','броне','прочн','незыблем'],
      magic:['магия','магич','руна','рунн','зачаров','пламя','лёд','гром','древн','демон','дух','проклят','благослов'],
    };
    function kwScore(list){
      let hits = 0;
      list.forEach(k=>{ if (text.includes(k)) hits++; });
      return clamp(hits*18 + Math.round(rng()*22) + Math.min(text.length/10, 20), 5, 100);
    }
    const stats = {};
    Object.keys(kw).forEach(k=> stats[k] = Math.round(kwScore(kw[k])));
    stats.rare = clamp(Math.round(text.length/6 + rng()*20), 5, 100);
    return {
      ...stats,
      epithet: pickEpithetFromText(text, rng),
      flavor: buildStatFlavor(stats, rng),
    };
  }
  const a = scoreSubmission(subA, '-a-'+idA);
  const b = scoreSubmission(subB, '-b-'+idB);
  const verdictText = buildLocalVerdict(subA, subB, a, b);
  return {
    stats: { a: normStat(a), b: normStat(b) },
    epithets: { a: a.epithet, b: b.epithet },
    flavors: { a: a.flavor, b: b.flavor },
    verdictText,
  };
}

/* Достаём краткую "деталь" из сабмишена — конкретное слово/свойство,
   которое можно вставить в вердикт, чтобы он звучал привязанным
   к реальному описанию, а не общей фразой на любой случай. */
function extractSwordDetail(sub){
  if (sub.type === 'market'){
    const purchases = sub.purchases || {};
    const top = TRAITS.filter(t=>!t.isRune)
      .sort((x,y)=> (purchases[y.key]||0) - (purchases[x.key]||0))[0];
    const lvl = purchases[top.key] || 0;
    if (lvl === 0) return 'едва вложенные в него монеты';
    return `выкупленн${top.key==='guard'?'ую':'ый'} на торге ${top.name.toLowerCase()}`;
  }
  const text = (sub.text || '').trim();
  if (!text) return 'молчание вместо описания';
  // берём первый содержательный фрагмент текста (до точки/запятой), обрезая до разумной длины
  const firstChunk = text.split(/[.,;\n]/)[0].trim();
  const words = firstChunk.split(/\s+/).slice(0, 7).join(' ');
  return words || firstChunk.slice(0, 40);
}

function buildLocalVerdict(subA, subB, a, b){
  const detailA = extractSwordDetail(subA);
  const detailB = extractSwordDetail(subB);
  const templates = [
    `Два клинка выходят из тени наковальни: ${a.epithet} несёт в себе «${detailA}», а ${b.epithet} отвечает тем, что в нём — «${detailB}». Металл ещё не остыл, но то, как эти две сути сталкиваются, уже решает исход.`,
    `${a.epithet} шагает вперёд с тем, что было в него вложено — «${detailA}»; ${b.epithet} встречает удар своим — «${detailB}». Именно в этом столкновении и рождается победитель.`,
    `Один клинок держится на «${detailA}» — это ${a.epithet}. Другой — на «${detailB}» — это ${b.epithet}. Наковальня решает не по имени, а по сути.`,
  ];
  const rng = seededRandom('verdict-' + detailA + detailB + a.epithet + b.epithet);
  return templates[Math.floor(rng()*templates.length)];
}
function normStat(s){
  return { sharp:s.sharp,size:s.size,light:s.light,balance:s.balance,guard:s.guard,magic:s.magic,rare:s.rare };
}
/* Строит атмосферное описание (2-3 предложения) из фактических характеристик,
   чтобы текст локального резервного "ИИ" совпадал с цифрами, а не был общей фразой. */
const STAT_FLAVOR_LINES = {
  sharp:   { high:'Кромка держит заточку, будто только что вышла из-под точильного камня — режет глубоко и без усилий', low:'Кромка стёрта и тупа, удары скорее давят, чем режут' },
  size:    { high:'Клинок тяжёл и длинен, каждый взмах перекрывает большую дугу пространства', low:'Клинок короток и лёгок по охвату, до противника ему нужно ещё дотянуться' },
  light:   { high:'Меч на удивление лёгок в руке — им можно бить часто и почти без промедления', low:'Меч неповоротлив, каждый следующий удар запаздывает' },
  balance: { high:'Баланс выверен почти идеально — рука не устаёт держать точный прицел', low:'Баланс сбит, клинок норовит увести удар в сторону' },
  guard:   { high:'Гарда и клинок прикрывают руку и корпус на совесть, парировать этим мечом — одно удовольствие', low:'Защиты почти нет — этот меч живёт атакой, а не обороной' },
  magic:   { high:'От металла исходит явная магическая сила, будто внутри клинка что-то тлеет', low:'Никакой магии в нём не чувствуется — обычная сталь и ничего больше' },
};
function buildStatFlavor(stats, rng){
  const keys = ['sharp','size','light','balance','guard','magic'];
  const ranked = keys.slice().sort((x,y)=> stats[y]-stats[x]);
  const top = ranked[0];
  const bottom = ranked[ranked.length-1];
  const lineFor = (key)=> STAT_FLAVOR_LINES[key][ stats[key] >= 55 ? 'high' : 'low' ];
  let sentences = [ lineFor(top) ];
  if (bottom !== top) sentences.push(lineFor(bottom));
  if (stats.rare >= 60){
    sentences.push('Что-то в самой задумке этого клинка редко встречается даже среди кузнецов.');
  } else if (sentences.length < 2){
    sentences.push('В остальном клинок держится середины — ни выдающихся сильных, ни явных слабых сторон.');
  }
  return sentences.join('. ').replace(/\.\.$/,'.') + (sentences[sentences.length-1].endsWith('.') ? '' : '.');
}
function pickEpithetFromLevels(purchases, rng){
  const top = TRAITS.filter(t=>!t.isRune).sort((x,y)=> (purchases[y.key]||0)-(purchases[x.key]||0))[0];
  const map = {
    sharp:['Клык наковальни','Бритва торга','Острие расчёта'],
    size:['Длань рынка','Тяжкий довод','Исполин прилавка'],
    light:['Вихрь монет','Скорый расчёт','Лёгкая рука'],
    balance:['Верное мерило','Точный вес','Равновесие цен'],
    guard:['Щит скупца','Крепкий довод','Броня расчётливого'],
  };
  const list = map[top.key] || ['Меч торга'];
  return list[Math.floor(rng()*list.length)];
}
function pickEpithetFromText(text, rng){
  const pool = ['Голос горна','Шёпот стали','Отголосок легенды','Клинок из молчания','Дитя вулкана','Приговор в металле','Сталь без имени','Эхо древней ковки'];
  return pool[Math.floor(rng()*pool.length)];
}

/* ---------------------------- Rendering: duel result ------------------------------ */
function statLabel(key){
  return { sharp:'Урон', size:'Размер', light:'Скорость', balance:'Баланс', guard:'Защита', magic:'Магия', rare:'Редкость' }[key];
}
function statClass(key){
  return { sharp:'dmg', size:'', light:'', balance:'', guard:'def', magic:'magic', rare:'rare' }[key] || '';
}

function renderPlayerDescBlock(sub){
  if (!sub) return '';
  if (sub.type === 'freeform'){
    return `
      <div class="sword-desc-block">
        <div class="sd-label">Описание кузнеца</div>
        <div class="sd-text">${escapeHtml(sub.text || '')}</div>
      </div>`;
  }
  // market: список того, что игрок купил за монеты
  const purchases = sub.purchases || {};
  const pills = TRAITS.map(t=>{
    const lvl = purchases[t.key] || 0;
    const cls = 'sd-purchase-pill' + (lvl===0 ? ' zero' : '');
    return `<span class="${cls}">${escapeHtml(t.name)}: ${lvl}</span>`;
  }).join('');
  return `
    <div class="sword-desc-block">
      <div class="sd-label">Покупки на торге (потрачено ${sub.spent||0}₪)</div>
      <div class="sd-purchases">${pills}</div>
    </div>`;
}

function renderSwordCard(elId, side, sub, stats, epithet, flavor, isWinner, ownerName){
  const el = $(elId);
  el.classList.toggle('winner', isWinner);
  const order = ['sharp','size','light','balance','guard','magic','rare'];
  el.innerHTML = `
    ${isWinner ? '<div class="crown">👑</div>' : ''}
    <div class="owner">${escapeHtml(ownerName)}</div>
    <svg class="sword-render" viewBox="0 0 220 170">${renderSwordSvg(stats)}</svg>
    <div class="epithet">${escapeHtml(epithet)}</div>
    <div class="flavor">${escapeHtml(flavor||'')}</div>
    <div class="stat-list">
      ${order.map(k=>`
        <div class="stat-line">
          <div class="s-name">${statLabel(k)}</div>
          <div class="stat-track"><div class="stat-fill ${statClass(k)}" data-target="${stats[k]}" style="width:0%"></div></div>
          <div class="s-num">${stats[k]}</div>
        </div>`).join('')}
    </div>
    ${renderPlayerDescBlock(sub)}
  `;
  requestAnimationFrame(()=>{
    setTimeout(()=>{
      el.querySelectorAll('.stat-fill').forEach(f=>{ f.style.width = f.dataset.target + '%'; });
    }, 120);
  });
}

function renderSwordSvg(stats){
  // Форма клинка отражает характеристики: длина ~ size, ширина ~ sharp(тоньше=острее), волнистость ~ magic
  const length = 40 + stats.size*0.9;
  const width = 16 - (stats.sharp/100)*7;
  const wob = stats.magic > 55;
  const color = stats.magic > 70 ? '#a680d9' : (stats.sharp > 70 ? '#ffd8c2' : '#e7edef');
  const y0 = 160 - length;
  const path = wob
    ? `M110,${y0} C ${110-width},${y0+length*0.3} ${110+width},${y0+length*0.6} 110,${160-30}`
    : `M${110-width/2},${y0} L${110+width/2},${y0} L${110+width/2-2},${160-30} L${110-width/2+2},${160-30} Z`;
  return `
    <defs><linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="#8fa3ad"/></linearGradient></defs>
    <path d="${path}" fill="url(#bg2)" stroke="#5c6f77" stroke-width="1.5"/>
    <rect x="88" y="130" width="44" height="10" rx="2" fill="#d9642c"/>
    <rect x="103" y="140" width="14" height="26" rx="4" fill="#3a2e26"/>
    <circle cx="110" cy="166" r="6" fill="${stats.rare>60?'#c9a24b':'#8a7a6a'}"/>
    ${stats.guard>60 ? `<path d="M78,132 Q110,148 142,132" stroke="#8fa3ad" stroke-width="2" fill="none"/>` : ''}
  `;
}

/* ---------------------------- Battle intro (clash animation) ---------------------- */
const BATTLE_INTRO_MS = 2200;
const BATTLE_CAPTIONS = [
  'Кузнец-дух взвешивает оба клинка…',
  'Сталь звенит, характеристики проступают…',
  'Ещё один вдох перед вердиктом…',
];
let battleIntroShownForRound = null;
function playBattleIntroThenResult(result, ids, subs){
  // Заставку показываем один раз на раунд — если игрок уже видел её (например,
  // при повторном срабатывании listener'а), сразу переходим к результату.
  if (battleIntroShownForRound === state.round){
    renderDuelResult(result, ids, subs);
    return;
  }
  battleIntroShownForRound = state.round;

  const [idA, idB] = ids;
  $('#bi-name-a').textContent = playerName(idA);
  $('#bi-name-b').textContent = playerName(idB);
  const captionEl = $('#bi-caption');
  let ci = 0;
  captionEl.textContent = BATTLE_CAPTIONS[0];
  const captionTimer = setInterval(()=>{
    ci = (ci + 1) % BATTLE_CAPTIONS.length;
    captionEl.textContent = BATTLE_CAPTIONS[ci];
  }, 700);

  show('screen-battle-intro');
  playSound('forge');

  setTimeout(()=>{
    clearInterval(captionTimer);
    renderDuelResult(result, ids, subs);
  }, BATTLE_INTRO_MS);
}

let lastResultRenderedRound = null;
function renderDuelResult(result, ids, subs){
  const { idA, idB, stats, epithets, flavors, winnerId, verdictText, crit } = result;
  show('screen-duel');
  if (lastResultRenderedRound !== state.round){
    playSound(winnerId===state.myId ? 'win' : 'clang');
  }

  const nameA = playerName(idA), nameB = playerName(idB);
  renderSwordCard('#sword-card-a','a', subs[idA], stats.a, epithets.a, flavors.a, winnerId===idA, nameA);
  renderSwordCard('#sword-card-b','b', subs[idB], stats.b, epithets.b, flavors.b, winnerId===idB, nameB);

  $('#verdict-title').textContent = winnerId===state.myId ? 'Ваш клинок выстоял!' : (winnerId ? `Побеждает ${playerName(winnerId)}` : 'Ничья на грани стали');
  $('#verdict-text').textContent = verdictText;
  $('#verdict-meta').textContent = crit ? '⚡ Решающий удар — характеристики были почти равны' : 'Победа определена суммарной силой клинка';

  state.roomRef.child('score').once('value').then(snap=> renderDuelScoreStrip(snap.val()||{}, ids));

  if (lastResultRenderedRound !== state.round){
    lastResultRenderedRound = state.round;
    renderRematchState();
  }
}

function renderDuelScoreStrip(scoreObj, ids){
  const strip = $('#duel-score-strip');
  strip.innerHTML = ids.map(id=>`<div class="score-box"><div class="n">${scoreObj[id]||0}</div><div class="l">${escapeHtml(playerName(id))}</div></div>`).join('');
}

function renderHistory(historyObj){
  const list = $('#history-list');
  const rounds = Object.keys(historyObj).map(Number).sort((a,b)=>b-a);
  if (rounds.length===0){ list.innerHTML = '<span class="small-muted">Дуэлей ещё не было.</span>'; return; }
  list.innerHTML = rounds.map(r=>{
    const h = historyObj[r];
    return `<div class="history-item"><span class="h-round">Раунд ${r} · ${h.mode==='freeform'?'Кузница слов':'Торг монет'}</span><span class="h-win">🏆 ${escapeHtml(playerName(h.winnerId))}</span></div>`;
  }).join('');
}

/* ---------------------------- Rematch flow ----------------------------------------- */
let rematchListenerRound = null;
function renderRematchState(){
  if (rematchListenerRound !== null){
    state.roomRef.child('round/' + rematchListenerRound + '/rematchVotes').off();
  }
  rematchListenerRound = state.round;
  state.roomRef.child('round/' + state.round + '/rematchVotes').on('value', snap=>{
    const votes = snap.val() || {};
    const ids = Object.keys(state.players);
    const bothVoted = ids.length===2 && ids.every(id=>votes[id]);
    $('#btn-rematch').textContent = votes[state.myId] ? '✓ Ждём соперника…' : '⚔ Реванш';
    if (bothVoted){
      startNextRound();
    }
  });
}
$('#btn-rematch').addEventListener('click', ()=>{
  if (state.isSpectator){ toast('Наблюдатели не голосуют за реванш.'); return; }
  state.roomRef.child('round/' + state.round + '/rematchVotes/' + state.myId).set(true);
  toast('Голос за реванш учтён.');
});
function startNextRound(){
  const nextRound = state.round + 1;
  battleIntroShownForRound = null;
  state.roomRef.child('currentRound').set(nextRound);
  // small delay so both clients see the same transition
  setTimeout(()=>{
    show('screen-lobby');
    toast('Раунд ' + nextRound + ' начинается — выберите режим заново.');
  }, 400);
}
$('#btn-change-mode').addEventListener('click', ()=>{
  show('screen-lobby');
});
$('#btn-back-home').addEventListener('click', leaveRoom);

/* ---------------------------- Modal helper ------------------------------------------ */
function openModal(title, html, actions){
  $('#modal-title').textContent = title;
  $('#modal-text').innerHTML = html;
  const actWrap = $('#modal-actions');
  actWrap.innerHTML = '';
  actions.forEach(a=>{
    const b = document.createElement('button');
    b.className = 'btn ' + (a.primary ? 'btn-primary':'btn-ghost');
    b.textContent = a.label;
    b.addEventListener('click', a.action);
    actWrap.appendChild(b);
  });
  $('#modal-overlay').classList.add('active');
}
function closeModal(){ $('#modal-overlay').classList.remove('active'); }
$('#modal-overlay').addEventListener('click', e=>{ if (e.target.id==='modal-overlay') closeModal(); });

/* ---------------------------- Escape helper ------------------------------------------ */
function escapeHtml(str){
  return String(str||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------------------- Boot ------------------------------------------------- */
initNameGate();

})();