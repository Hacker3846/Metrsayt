/* ==========================================================================
   КУЗНИЦА КЛИНКОВ — ai-config.js
   Страница настройки "духа кузницы": API-ключ, модель, системный промпт.

   Хранение — двухуровневое:
     1) localStorage этого браузера (kk_ai_api_key/model/prompt) — как раньше,
        читается напрямую основным game.js, работает даже без выбора комнаты.
     2) Firebase Realtime DB, путь /rooms/{roomId}/aiSettings — общая запись
        на комнату, видна с любого устройства всем, кто в этой комнате.
        Хранится максимум 2 суток: пишем expiresAt = сейчас + 2 дня, а при
        чтении (здесь и в game.js) запись старше срока считается просроченной
        и удаляется — Realtime DB не умеет TTL сама, поэтому эта проверка
        живёт в клиентском коде на обеих страницах.
   ========================================================================== */

(function(){
"use strict";

const KEY_API   = 'kk_ai_api_key';
const KEY_MODEL = 'kk_ai_model';
const KEY_PROMPT= 'kk_ai_prompt';
const ROOM_COUNT = 9;
const TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 дня

const firebaseConfig = { databaseURL: "https://messengerb-dcc80-default-rtdb.europe-west1.firebasedatabase.app" };
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

let currentRoomId = null; // null = настройки только локальные, без привязки к комнате
let roomSettingsRef = null;

/* ---------------------------- Модели ------------------------------------- */
// Актуальный модельный ряд Anthropic (Claude Platform, июль 2026).
const MODELS = [
  {
    id:'claude-haiku-4-5-20251001',
    name:'Claude Haiku 4.5',
    desc:'Самый быстрый и дешёвый — годится для частых дуэлей',
    badge:'fast', badgeLabel:'быстрый',
  },
  {
    id:'claude-sonnet-5',
    name:'Claude Sonnet 5',
    desc:'Лучший баланс скорости и качества оценки клинков',
    badge:'balanced', badgeLabel:'баланс', recommended:true,
  },
  {
    id:'claude-opus-4-8',
    name:'Claude Opus 4.8',
    desc:'Самый вдумчивый судья — сложные и творческие описания',
    badge:'strong', badgeLabel:'мощный',
  },
  {
    id:'claude-fable-5',
    name:'Claude Fable 5',
    desc:'Флагман нового поколения — максимум воображения в вердиктах',
    badge:'strong', badgeLabel:'флагман',
  },
];

/* ---------------------------- Пресеты промптов ---------------------------- */
const PROMPT_DEFAULT = `Ты — беспристрастный ИИ-кузнец в игре-дуэли мечей. Тебе дают описание(я) двух мечей (либо текстовое описание, либо распределение очков по свойствам: острота, размер, лёгкость, баланс, защита, руны). Твоя задача — присвоить каждому мечу 6 числовых характеристик от 0 до 100: sharp (острота/урон), size (размер/охват), light (лёгкость/скорость), balance (баланс/точность), guard (защита), magic (магическая сила). Также добавь rare (0-100, редкость/уникальность концепции). Будь справедлив и последователен: разные по силе описания должны получать разные оценки, но не завышай оба меча одинаково. Придумай короткий эпитет (2-4 слова) для каждого меча. Также напиши flavor — атмосферное описание меча из 2-3 предложений (примерно 30-45 слов): оно ДОЛЖНО явно отражать именно те характеристики, которые ты только что присвоил этому мечу — если sharp высокий, опиши остроту и то, как клинок режет; если magic высокий, опиши магическое свечение или силу рун; если guard низкий, упомяни лёгкую или почти отсутствующую защиту, и так далее для самых заметных (самых высоких и самых низких) характеристик. Не пиши обтекаемо — цифры и текст должны совпадать. Напиши краткий вердикт дуэли (verdictText, 2-4 предложения, художественно, без явного объявления победителя числами — это сделает игра). ВАЖНО: verdictText обязан явно опираться на КОНКРЕТНЫЕ детали ОБОИХ описаний — упомяни хотя бы одну деталь из меча A и хотя бы одну деталь из меча B, и опиши, как именно эти конкретные свойства столкнулись друг с другом в бою. Не пиши общими фразами, которые подошли бы любому мечу. Ответь СТРОГО в формате JSON без пояснений и без markdown-разметки:
{"a":{"sharp":0,"size":0,"light":0,"balance":0,"guard":0,"magic":0,"rare":0,"epithet":"","flavor":""},"b":{...},"verdictText":""}`;

const PROMPT_BRUTAL = `Ты — суровый и предельно реалистичный ИИ-кузнец-судья. Оценивай мечи по практической боевой логике, без сантиментов: нелепые или противоречивые описания ("невидимый меч, который режет всё, включая время") должны получать низкие и посредственные оценки, а не награду за фантазию. Присвой каждому мечу 6 характеристик от 0 до 100: sharp, size, light, balance, guard, magic, плюс rare (0-100). Пиши короткий, жёсткий, слегка мрачный эпитет (2-4 слова) в духе поля боя, а не сказки. Также напиши flavor — сухое, протокольное описание клинка из 2-3 предложений (примерно 30-45 слов), которое обязано напрямую отражать присвоенные характеристики: высокий sharp — опиши, как клинок рассекает; низкий guard — прямо укажи на уязвимость и слабую защиту; высокий magic — опиши источник магической силы; и так далее по самым заметным цифрам. Никаких расплывчатых похвал, не подкреплённых цифрами. verdictText — 2-4 сухих, будто протокольных предложения о столкновении клинков, без явного называния победителя цифрами. ВАЖНО: в verdictText обязательно укажи конкретную деталь из описания меча A и конкретную деталь из описания меча B и сухо, по-протокольному зафиксируй, как именно эти детали столкнулись — никаких общих фраз, которые подошли бы любой паре мечей. Ответь СТРОГО в формате JSON без пояснений и без markdown-разметки:
{"a":{"sharp":0,"size":0,"light":0,"balance":0,"guard":0,"magic":0,"rare":0,"epithet":"","flavor":""},"b":{...},"verdictText":""}`;

const PROMPT_WHIMSICAL = `Ты — сказочный ИИ-кузнец, влюблённый в мифологию и метафоры. Читая описание меча (текст или уровни покупок: острота, размер, лёгкость, баланс, защита, руны), придумывай яркий образ мира, из которого мог бы явиться такой клинок, и уже из этого образа выводи 6 характеристик от 0 до 100: sharp, size, light, balance, guard, magic, плюс rare (0-100, насколько уникальна сама идея). Эпитет (2-4 слова) должен звучать как имя легендарного оружия. Flavor — 2-3 поэтичных предложения (примерно 30-45 слов), как строки из баллады, но при этом они обязаны балладным языком передавать именно те характеристики, которые ты присвоил: высокая острота — образ разящего, жалящего клинка; высокая магия — образ сияния, духов или древней силы; низкая защита — образ хрупкости или открытого удара; и так для самых ярких цифр меча. Красота не должна противоречить цифрам. verdictText — 2-4 поэтичных предложения о столкновении клинков без прямого указания победителя числами. ВАЖНО: вплети в verdictText конкретный образ или деталь из описания меча A и конкретный образ или деталь из описания меча B, показав балладным языком, как именно эти два конкретных образа схлестнулись в бою — не ограничивайся общими красивостями, которые подошли бы любой паре мечей. При этом сохраняй справедливость: образность не должна маскировать то, что одно описание объективно слабее другого. Ответь СТРОГО в формате JSON без пояснений и без markdown-разметки:
{"a":{"sharp":0,"size":0,"light":0,"balance":0,"guard":0,"magic":0,"rare":0,"epithet":"","flavor":""},"b":{...},"verdictText":""}`;

const PROMPT_STRICT = `Ты — формальный ИИ-арбитр без художественных вольностей. Анализируй описание меча (текст или уровни покупок: острота, размер, лёгкость, баланс, защита, руны) как техническую спецификацию. Присваивай 6 характеристик от 0 до 100 (sharp, size, light, balance, guard, magic) и rare (0-100) строго на основе того, что явно указано или логически следует из описания — не додумывай лишнего, при нехватке данных ставь среднее значение около 40-50. Эпитет — короткое техническое обозначение (2-4 слова, без пафоса). Flavor — 2-3 нейтральных описательных предложения (примерно 30-45 слов), перечисляющих ключевые параметры клинка со ссылкой на присвоенные цифры: например, прямо укажи, что острота высокая/средняя/низкая, что защита слабая или сильная, что магический уровень такой-то — так, чтобы текст был проверяемым отражением чисел, а не отдельным от них художеством. verdictText — 2-3 фактических предложения об исходе столкновения, без художественных приёмов и без называния победителя числами. ВАЖНО: verdictText обязан сослаться на конкретный указанный параметр или деталь меча A и конкретный указанный параметр или деталь меча B и зафиксировать, как именно они соотнеслись друг с другом — не используй общие формулировки, применимые к любой паре мечей. Ответь СТРОГО в формате JSON без пояснений и без markdown-разметки:
{"a":{"sharp":0,"size":0,"light":0,"balance":0,"guard":0,"magic":0,"rare":0,"epithet":"","flavor":""},"b":{...},"verdictText":""}`;

const PRESETS = {
  default: PROMPT_DEFAULT,
  brutal: PROMPT_BRUTAL,
  whimsical: PROMPT_WHIMSICAL,
  strict: PROMPT_STRICT,
};

/* ---------------------------- Утилиты ------------------------------------- */
function $(sel){ return document.querySelector(sel); }
function toast(msg, ms=3200){
  const wrap = $('#toast-wrap');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(()=>{ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(()=>t.remove(), 320); }, ms);
}
function escapeHtml(str){
  return String(str||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------------------- Рендер модели-карточек ------------------------ */
let selectedModelId = null;
let usingCustomModel = false;

function renderModelGrid(){
  const grid = $('#model-grid');
  grid.innerHTML = '';
  MODELS.forEach(m=>{
    const card = document.createElement('div');
    card.className = 'model-card';
    card.dataset.modelId = m.id;
    card.innerHTML = `
      <div class="m-name">${escapeHtml(m.name)}${m.recommended ? ' ★' : ''}</div>
      <div class="m-desc">${escapeHtml(m.desc)}</div>
      <span class="m-badge ${m.badge}">${escapeHtml(m.badgeLabel)}</span>
    `;
    card.addEventListener('click', ()=>{
      usingCustomModel = false;
      $('#custom-model-checkbox').checked = false;
      $('#custom-model-row').classList.remove('active');
      selectModel(m.id);
    });
    grid.appendChild(card);
  });
}

function selectModel(id){
  selectedModelId = id;
  document.querySelectorAll('.model-card').forEach(c=>{
    c.classList.toggle('selected', c.dataset.modelId === id && !usingCustomModel);
  });
}

$('#custom-model-checkbox').addEventListener('change', e=>{
  usingCustomModel = e.target.checked;
  $('#custom-model-row').classList.toggle('active', usingCustomModel);
  if (usingCustomModel){
    document.querySelectorAll('.model-card').forEach(c=> c.classList.remove('selected'));
    $('#custom-model-input').focus();
  } else if (selectedModelId){
    selectModel(selectedModelId);
  }
});

/* ---------------------------- Room scope (select + URL) ---------------------- */
function renderRoomOptions(){
  const select = $('#room-select');
  for (let i=1;i<=ROOM_COUNT;i++){
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = 'Комната №' + i;
    select.appendChild(opt);
  }
}

function getRoomFromUrl(){
  const params = new URLSearchParams(location.search);
  const r = parseInt(params.get('room'));
  return (r>=1 && r<=ROOM_COUNT) ? r : null;
}

function setRoomScope(roomId){
  if (roomSettingsRef) roomSettingsRef.off();
  currentRoomId = roomId;
  $('#room-select').value = roomId ? String(roomId) : '';

  const hint = $('#room-scope-hint');
  const saveDesc = $('#save-desc');
  if (roomId){
    hint.textContent = `Настройки будут сохранены в общую базу для комнаты №${roomId} и станут видны второму игроку там же.`;
    saveDesc.textContent = `Настройки сохранятся в базу комнаты №${roomId} на 2 суток и в этот браузер — их читает основная игра при каждой дуэли.`;
    roomSettingsRef = db.ref('rooms/' + roomId + '/aiSettings');
    roomSettingsRef.on('value', onRoomSettingsChanged);
  } else {
    hint.textContent = 'Без привязки к комнате настройки останутся только в этом браузере, как и раньше.';
    saveDesc.textContent = 'Настройки применяются сразу в этом браузере — их читает основная игра при каждой дуэли.';
    roomSettingsRef = null;
    refreshStatusBanner();
  }

  history.replaceState(null, '', roomId ? ('?room=' + roomId) : location.pathname);
}

function onRoomSettingsChanged(snap){
  const remote = snap.val();
  const now = Date.now();
  if (remote && remote.expiresAt && remote.expiresAt > now){
    // Свежая запись из БД — подтягиваем её в поля формы и в локальный кеш
    $('#api-key').value = remote.apiKey || '';
    promptArea.value = remote.prompt || PROMPT_DEFAULT;
    updatePromptCount();
    applyModelValue(remote.model || '');
    localStorage.setItem(KEY_API, remote.apiKey || '');
    localStorage.setItem(KEY_MODEL, remote.model || '');
    localStorage.setItem(KEY_PROMPT, remote.prompt || '');
  } else if (remote && remote.expiresAt && remote.expiresAt <= now){
    // Просрочено — удаляем и откатываемся на статус "не настроено" для этой комнаты
    roomSettingsRef.remove();
  }
  refreshStatusBanner();
}

function applyModelValue(modelId){
  if (!modelId){ return; }
  const known = MODELS.some(m=>m.id===modelId);
  if (known){
    usingCustomModel = false;
    $('#custom-model-checkbox').checked = false;
    $('#custom-model-row').classList.remove('active');
    selectModel(modelId);
  } else {
    usingCustomModel = true;
    $('#custom-model-checkbox').checked = true;
    $('#custom-model-row').classList.add('active');
    $('#custom-model-input').value = modelId;
  }
}

$('#room-select').addEventListener('change', e=>{
  const val = e.target.value;
  setRoomScope(val ? parseInt(val) : null);
});
$('#toggle-key-visibility').addEventListener('click', ()=>{
  const input = $('#api-key');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('#toggle-key-visibility').textContent = showing ? '👁' : '🙈';
});

/* ---------------------------- Prompt presets & counter ----------------------- */
const promptArea = $('#ai-prompt');
function updatePromptCount(){
  $('#prompt-count').textContent = promptArea.value.length;
}
promptArea.addEventListener('input', updatePromptCount);

document.querySelectorAll('.preset-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const key = btn.dataset.preset;
    promptArea.value = PRESETS[key];
    updatePromptCount();
    toast('Пресет применён: ' + btn.textContent.replace(/^\S+\s/, ''));
  });
});

/* ---------------------------- Status banner ---------------------------------- */
function refreshStatusBanner(){
  const key = localStorage.getItem(KEY_API);
  const model = localStorage.getItem(KEY_MODEL);
  const banner = $('#status-banner');
  const text = $('#status-text');

  if (!key || !model){
    banner.classList.remove('active');
    banner.classList.add('inactive');
    text.textContent = 'Дух кузницы не настроен — используется резервный локальный кузнец.';
    return;
  }

  banner.classList.remove('inactive');
  banner.classList.add('active');

  if (currentRoomId){
    db.ref('rooms/' + currentRoomId + '/aiSettings/expiresAt').once('value').then(snap=>{
      const expiresAt = snap.val();
      if (expiresAt && expiresAt > Date.now()){
        const daysLeft = Math.max(1, Math.ceil((expiresAt - Date.now()) / (24*60*60*1000)));
        text.innerHTML = `Дух кузницы настроен для комнаты №${currentRoomId} — модель <strong>${escapeHtml(model)}</strong>. Запись в базе сгорит через ${daysLeft} д.`;
      } else {
        text.innerHTML = `Дух кузницы настроен локально — модель <strong>${escapeHtml(model)}</strong>. Пока не сохранено в базу комнаты №${currentRoomId}.`;
      }
    });
  } else {
    text.innerHTML = `Дух кузницы настроен в этом браузере — модель <strong>${escapeHtml(model)}</strong>. Игра использует его в дуэлях.`;
  }
}

/* ---------------------------- Load existing settings -------------------------- */
function loadExisting(){
  renderRoomOptions();

  const savedKey = localStorage.getItem(KEY_API) || '';
  const savedModel = localStorage.getItem(KEY_MODEL) || '';
  const savedPrompt = localStorage.getItem(KEY_PROMPT) || '';

  $('#api-key').value = savedKey;
  promptArea.value = savedPrompt || PROMPT_DEFAULT;
  updatePromptCount();

  renderModelGrid();

  if (savedModel){
    applyModelValue(savedModel);
  } else {
    // По умолчанию предлагаем рекомендованную модель, но не сохраняем, пока не нажмут "Сохранить"
    const recommended = MODELS.find(m=>m.recommended) || MODELS[0];
    selectModel(recommended.id);
  }

  const roomFromUrl = getRoomFromUrl();
  setRoomScope(roomFromUrl); // roomFromUrl может быть null — это ок, значит "только браузер"

  refreshStatusBanner();
}

/* ---------------------------- Validation -------------------------------------- */
function currentModelValue(){
  if (usingCustomModel){
    return $('#custom-model-input').value.trim();
  }
  return selectedModelId;
}
function validate(showToasts){
  const key = $('#api-key').value.trim();
  const model = currentModelValue();
  const prompt = promptArea.value.trim();

  if (!key){ if(showToasts) toast('Впишите API-ключ.'); return null; }
  if (!key.startsWith('sk-or')){ if(showToasts) toast('Ключ обычно начинается с "sk-or-" — проверьте, что скопирован верно.'); }
  if (!model){ if(showToasts) toast('Выберите модель или впишите её строку вручную.'); return null; }
  if (!prompt || prompt.length < 20){ if(showToasts) toast('Промпт слишком короткий — опишите, как судить мечи.'); return null; }
  if (!/json/i.test(prompt)){ if(showToasts) toast('⚠ В промпте не упоминается формат JSON — игра может не разобрать ответ. Сохранение всё равно продолжится.'); }

  return { key, model, prompt };
}

/* ---------------------------- Save / Reset -------------------------------------- */
$('#btn-save').addEventListener('click', ()=>{
  const data = validate(true);
  if (!data) return;

  localStorage.setItem(KEY_API, data.key);
  localStorage.setItem(KEY_MODEL, data.model);
  localStorage.setItem(KEY_PROMPT, data.prompt);

  if (currentRoomId){
    const expiresAt = Date.now() + TTL_MS;
    const btn = $('#btn-save');
    btn.disabled = true;
    db.ref('rooms/' + currentRoomId + '/aiSettings').set({
      apiKey: data.key,
      model: data.model,
      prompt: data.prompt,
      savedAt: firebase.database.ServerValue.TIMESTAMP,
      expiresAt,
    }).then(()=>{
      refreshStatusBanner();
      toast(`Дух кузницы сохранён для комнаты №${currentRoomId} на 2 суток и в этот браузер.`);
    }).catch(err=>{
      console.warn('Не удалось сохранить в БД:', err);
      toast('Сохранено локально, но не удалось записать в базу комнаты — проверьте соединение.');
    }).finally(()=>{
      btn.disabled = false;
    });
  } else {
    refreshStatusBanner();
    toast('Дух кузницы сохранён в этом браузере.');
  }
});

$('#btn-open-game').addEventListener('click', ()=>{
  window.location.href = currentRoomId ? ('index.html?room=' + currentRoomId) : 'index.html';
});

$('#btn-reset').addEventListener('click', ()=>{
  if (!confirm('Стереть сохранённый ключ, модель и промпт из этого браузера' + (currentRoomId ? ` и из базы комнаты №${currentRoomId}` : '') + '?')) return;

  localStorage.removeItem(KEY_API);
  localStorage.removeItem(KEY_MODEL);
  localStorage.removeItem(KEY_PROMPT);
  $('#api-key').value = '';
  promptArea.value = PROMPT_DEFAULT;
  updatePromptCount();
  usingCustomModel = false;
  $('#custom-model-checkbox').checked = false;
  $('#custom-model-row').classList.remove('active');
  $('#custom-model-input').value = '';
  const recommended = MODELS.find(m=>m.recommended) || MODELS[0];
  selectModel(recommended.id);
  $('#test-result').classList.remove('show','ok','fail','loading');

  if (currentRoomId){
    db.ref('rooms/' + currentRoomId + '/aiSettings').remove().finally(()=>{
      refreshStatusBanner();
      toast('Настройки духа кузницы стёрты из браузера и из базы комнаты №' + currentRoomId + '.');
    });
  } else {
    refreshStatusBanner();
    toast('Настройки духа кузницы стёрты — игра вернулась к резервному кузнецу.');
  }
});

/* ---------------------------- Test connection ------------------------------------ */
$('#btn-test-connection').addEventListener('click', async ()=>{
  const data = validate(true);
  if (!data) return;

  const btn = $('#btn-test-connection');
  const resultBox = $('#test-result');
  btn.disabled = true;
  resultBox.className = 'test-result show loading';
  resultBox.textContent = 'Дух кузницы пробуждается… отправляем тестовую дуэль.';

  const testUserPrompt = `Меч игрока A ("Испытатель"):\nТекстовое описание меча: "короткий кинжал из ржавого железа, без магии, тупой от старости"\n\nМеч игрока B ("Проверка"):\nТекстовое описание меча: "сияющий двуручный меч из звёздного металла, окутанный пламенем и рунами древних королей"\n\nСгенерируй характеристики и вердикт согласно системному промпту.`;

  try{
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization': 'Bearer ' + data.key,
      },
      body: JSON.stringify({
        model: data.model,
        max_tokens: 1600,
        messages: [
          { role:'system', content: data.prompt },
          { role:'user', content: testUserPrompt },
        ],
      }),
    });

    if (!resp.ok){
      const errText = await resp.text().catch(()=> '');
      throw new Error(`HTTP ${resp.status} ${resp.statusText}${errText ? ' — ' + errText.slice(0,200) : ''}`);
    }

    const json = await resp.json();
    const msgContent = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!msgContent) throw new Error('В ответе нет текстового блока.');

    const cleaned = msgContent.replace(/```json|```/g,'').trim();
    let parsed;
    try{
      parsed = JSON.parse(cleaned);
    }catch(parseErr){
      resultBox.className = 'test-result show fail';
      resultBox.textContent = `⚠ Дух ответил, но не в формате JSON — игра не сможет это прочитать и будет использовать резервный кузнец.\n\nСырой ответ:\n${msgContent.slice(0,600)}`;
      return;
    }

    resultBox.className = 'test-result show ok';
    resultBox.textContent =
      `✓ Дух кузницы откликнулся.\n\n` +
      `Меч A: ${JSON.stringify(parsed.a, null, 0)}\n` +
      `Меч B: ${JSON.stringify(parsed.b, null, 0)}\n\n` +
      `Вердикт: ${parsed.verdictText || '(пусто)'}`;
    toast('Связь с духом кузницы установлена.');

  }catch(err){
    resultBox.className = 'test-result show fail';
    resultBox.textContent = `✗ Не удалось получить ответ.\n${err.message}\n\nПроверьте ключ, доступность модели и то, что запросы с браузера не блокируются CORS-политикой на вашей сети.`;
  }finally{
    btn.disabled = false;
  }
});

/* ---------------------------- Boot ----------------------------------------------- */
loadExisting();

})();
