// ============================================================
// ИНТЕРФЕЙС И СЕТЬ
// Слой сети (Backend) отделён от логики: ядро знает только про PressureStore.
// Онлайн включается сам, если у страницы есть db и user; иначе игра автономна.
// ============================================================

const $ = sel => document.querySelector(sel);

// Графика: build.py подставляет сюда найденные в art/ файлы (имя без расширения -> путь).
// Нет файла для слота: элемент просто не рисуется, игра выглядит как прежде.
const ART = {};
// Запасные иконки из листа интерфейса, пока нет своей картинки слота.
const ART_FALLBACK = { 'ev-storm': 'ui-i-storm', 'ev-bankrupt': 'ui-i-broke', 'ev-salvage': 'ui-i-cargo', 'ev-sign-good': 'ui-i-void', 'good-coal': 'ui-i-coal', 'good-arms': 'ui-i-cannon' };
function artImg(slot, cls, alt) {
  if (!ART[slot] && ART_FALLBACK[slot] && ART[ART_FALLBACK[slot]]) return '<img class="art ' + cls + ' fb" src="' + ART[ART_FALLBACK[slot]] + '" alt="' + esc(alt || '') + '" decoding="async">';
  if (!ART[slot]) return '';
  return '<img class="art ' + cls + '" src="' + ART[slot] + '" alt="' + esc(alt || '') + '" loading="lazy" decoding="async">';
}
document.addEventListener('error', e => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.classList.contains('art')) t.remove();
}, true);
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString('ru-RU');

// ---------- состояние ----------
function loadSave() {
  try { const t = localStorage.getItem(SAVE_KEY); return t ? deserialize(t) : null; } catch (e) { return null; }
}
function writeSave() {
  try { localStorage.setItem(SAVE_KEY, serialize(S)); } catch (e) { /* хранилище может быть недоступно */ }
}

let S = loadSave() || newGame();
const store = new PressureStore();
let tab = 'market';
let selDest = null;
let toastTimer = null;
let confirmReset = false;
let bulletin = null;   // последнее событие в пути (гроза, находка, бой), пока не закрыто
let flightTimer = null;

const net = {
  mode: 'local',      // local | online
  writable: false,
  db: null,
  uid: null,
  board: [],
  lastScore: '',
  bestPeak: 0,
};

// ---------- сеть ----------
const pending = {};
let flushTimer = null;
let flushing = false;

function queueMarketWrite(key, d) {
  if (!net.db || !net.writable) return;
  pending[key] = d;
  if (!flushTimer) flushTimer = setTimeout(flushMarket, 600);
}

async function flushMarket() {
  flushTimer = null;
  if (flushing) { flushTimer = setTimeout(flushMarket, 600); return; }
  flushing = true;
  try {
    for (const key of Object.keys(pending)) {
      const d = pending[key];
      delete pending[key];
      try { await net.db.doc('market/' + key).set(d); }
      catch (e) { if (e && e.code === 'invalid_argument') { net.writable = false; renderNet(); } }
    }
  } finally { flushing = false; }
}

let scoreTimer = null;
let scoreBusy = false;
function scheduleScore() {
  if (!net.db || !net.writable || !net.uid) return;
  if (scoreTimer) clearTimeout(scoreTimer);
  scoreTimer = setTimeout(publishScore, 1500);
}
async function publishScore() {
  scoreTimer = null;
  if (!net.db || !net.writable || !net.uid) return;
  if (scoreBusy) { scoreTimer = setTimeout(publishScore, 1500); return; }
  const peak = Math.max(S.stats.peak || 0, net.bestPeak || 0);
  const doc = { name: S.name.slice(0, 24), worth: netWorth(S), peak, day: S.day, trips: S.stats.trips, over: !!S.over, ts: Date.now() };
  const sig = doc.name + '|' + doc.worth + '|' + doc.peak + '|' + doc.day + '|' + doc.over;
  if (sig === net.lastScore) return;
  scoreBusy = true;
  try { await net.db.doc('pilots/' + net.uid).set(doc); net.lastScore = sig; net.bestPeak = peak; }
  catch (e) { if (e && e.code === 'invalid_argument') { net.writable = false; renderNet(); } }
  finally { scoreBusy = false; }
}

async function goOnline() {
  try {
    const c = window.claude;
    if (!c || typeof c.use !== 'function') return;
    const [db, user] = await Promise.all([c.use('db'), c.use('user')]);
    if (!db || !user) return;
    net.uid = await user.id();
    let can = null;
    try { can = await user.can('data.write'); } catch (e) { /* неизвестно: решит первая запись */ }
    net.db = db;
    net.writable = !!net.uid && can !== false;
    net.mode = 'online';
    store.onWrite = queueMarketWrite;
    db.collection('market').onSnapshot(snap => {
      for (const d of snap.docs) if (d.exists) store.ingest(d.id, d.data());
      render();
    }, () => { net.mode = 'local'; renderNet(); });
    db.collection('pilots').orderBy('peak', 'desc').limit(20).onSnapshot(snap => {
      net.board = snap.docs.filter(d => d.exists).map(d => Object.assign({ id: d.id }, d.data()));
      const mine = net.board.find(r => r.id === net.uid);
      if (mine && Number(mine.peak) > net.bestPeak) net.bestPeak = Number(mine.peak);
      if (tab === 'rank') render();
    }, () => { /* рейтинг недоступен, игра продолжается */ });
    renderNet();
    scheduleScore();
  } catch (e) { /* остаёмся автономными */ }
}

// ---------- общие действия ----------
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg || '';
  if (toastTimer) clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(() => { el.textContent = ''; }, 3500);
}

function after(result) {
  if (result && result.ok === false && result.msg) toast(result.msg);
  else toast('');
  if (result && result.ev && result.ev.text && ['storm', 'salvage', 'pirates'].includes(result.ev.type)) {
    bulletin = { type: result.ev.type, text: result.ev.text };
  }
  trackPeak(S);
  checkBankrupt(S);
  writeSave();
  scheduleScore();
  render();
  if (S.over) showOver();
  else if (result && result.sign) showSign(result.sign);
}

// ---------- отрисовка ----------
function gauge(label, value, extra) {
  const ico = extra && extra.ico ? artImg('ui-i-' + extra.ico, 'gico', '') : '';
  return '<div class="gauge ' + (extra && extra.cls || '') + '">' + ico + '<div class="lab">' + label + '</div><div class="val">' + value + '</div>' + (extra && extra.bar || '') + '</div>';
}
function bar(frac, warnAt, critAt) {
  const f = clamp(frac, 0, 1);
  const cls = f <= critAt ? 'crit' : f <= warnAt ? 'warn' : '';
  return '<div class="bar ' + cls + '"><i style="width:' + Math.round(f * 100) + '%"></i></div>';
}

function renderGauges() {
  const st = stats(S);
  const cargo = cargoCount(S);
  $('#gauges').innerHTML =
    gauge('Казна', fmt(S.cash), { cls: 'money', ico: 'coin' }) +
    gauge('День', S.day, { ico: 'time' }) +
    gauge('Топливо', S.fuel + '<small> / ' + st.tank + '</small>', { ico: 'coal', bar: bar(S.fuel / st.tank, 0.35, 0.15) }) +
    gauge('Корпус', S.hull + '<small> / ' + st.hullMax + '</small>', { ico: 'repair', bar: bar(S.hull / st.hullMax, 0.5, 0.25) }) +
    gauge('Трюм', cargo + '<small> / ' + st.hold + '</small>', { ico: 'cargo', bar: bar(cargo / st.hold, 0, 0) });
}

function renderNet() {
  const el = $('#net');
  if (net.mode === 'online') {
    if (net.writable) { el.textContent = 'Онлайн · общий рынок'; el.className = 'net on'; }
    else { el.textContent = 'Онлайн · только чтение'; el.className = 'net ro'; }
  } else { el.textContent = 'Автономно'; el.className = 'net'; }
}

function renderTabs() {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
}

function renderLog() {
  const last = S.log.slice(-5).reverse();
  let b = '';
  if (bulletin) {
    const slot = { storm: 'ev-storm', salvage: 'ev-salvage', pirates: 'ev-pirates' }[bulletin.type];
    b = '<div class="bulletin">' + artImg(slot, 'bimg', '') + '<p>' + esc(bulletin.text) + '</p>' +
      '<button class="btn" data-act="bulletin-x" aria-label="Закрыть сообщение">×</button></div>';
  }
  $('#log').innerHTML = b + last.map(l => '<div><span class="d">д.' + l.d + '</span><span>' + esc(l.t) + '</span></div>').join('');
}

function renderMarket() {
  const p = PLANET[S.planet];
  const st = stats(S);
  const free = st.hold - cargoCount(S);
  const rows = GOODS.map(g => {
    const q = quote(S, store, S.planet, g.id);
    const have = S.hold[g.id] || 0;
    const avg = have ? Math.round((S.basis[g.id] || 0) / have) : 0;
    const tag = q.ratio <= 0.88 ? '<span class="tag cheap">дёшево</span>' : q.ratio >= 1.2 ? '<span class="tag dear">дорого</span>' : '';
    const pbPct = Math.round(q.pb * 100), psPct = Math.round(-q.ps * 100);
    const buyTrend = pbPct >= 2 ? '<small class="trend up">' + pbPct + '% от покупок</small>' : '';
    const sellTrend = psPct >= 2 ? '<small class="trend down">' + psPct + '% от продаж</small>' : '';
    return '<div class="row">' +
      '<div class="gname">' + artImg('good-' + g.id, 'gicon', '') + '<span>' + g.name + '</span>' + tag + '</div>' +
      '<div class="gprice"><b>' + q.buy + '</b><small>покупка</small>' + buyTrend + '</div>' +
      '<div class="gsell"><b>' + q.sell + '</b><small>продажа</small>' + sellTrend + '</div>' +
      '<div class="ghave">' + (have ? '<b>' + have + ' ящ.</b><small>себест. ' + avg + '</small>' : '<small>нет в трюме</small>') + '</div>' +
      '<div class="gact">' +
        '<button class="btn buy" data-act="trade" data-m="buy" data-g="' + g.id + '" aria-label="Купить ' + g.name + '"' + (free <= 0 || S.cash < q.buy ? ' disabled' : '') + '>Купить…</button>' +
        '<button class="btn sell" data-act="trade" data-m="sell" data-g="' + g.id + '" aria-label="Продать ' + g.name + '"' + (have ? '' : ' disabled') + '>Продать…</button>' +
      '</div></div>';
  }).join('');
  const needFuel = st.tank - S.fuel, needHull = st.hullMax - S.hull;
  return '<section class="panel">' + artImg('port-' + S.planet, 'hero-img', p.name) +
    '<header><div><div class="kind">' + esc(p.kind) + '</div><h2>' + esc(p.name) + '</h2></div><small>Свободно в трюме: ' + free + '</small></header>' +
    '<p class="lead">' + esc(p.desc) + '</p>' +
    '<div class="goods">' + rows + '</div>' +
    '<div class="services">' +
      '<div class="svc"><h3>Заправка</h3><small>' + FUEL_PRICE + ' за единицу</small><button class="btn" data-act="refuel"' + (needFuel <= 0 || S.cash < FUEL_PRICE ? ' disabled' : '') + '>' + (needFuel > 0 ? 'Заправить до полного (' + fmt(Math.min(needFuel, Math.floor(S.cash / FUEL_PRICE)) * FUEL_PRICE) + ')' : 'Бак полон') + '</button></div>' +
      '<div class="svc"><h3>Ремонт</h3><small>' + REPAIR_PRICE + ' за единицу прочности</small><button class="btn" data-act="repair"' + (needHull <= 0 || S.cash < REPAIR_PRICE ? ' disabled' : '') + '>' + (needHull > 0 ? 'Починить до полного (' + fmt(Math.min(needHull, Math.floor(S.cash / REPAIR_PRICE)) * REPAIR_PRICE) + ')' : 'Корпус цел') + '</button></div>' +
    '</div></section>';
}

function goodNames(ids) { return ids.map(i => GOOD[i].name).join(', '); }

function riskBar(pct, cls) {
  return '<div class="bar ' + (cls === 'high' ? 'crit' : cls === 'mid' ? 'warn' : '') + '" aria-hidden="true"><i style="width:' + clamp(pct, 0, 100) + '%"></i></div>';
}

function riskChip(pct) {
  const cls = pct < 20 ? 'low' : pct < 32 ? 'mid' : 'high';
  const word = pct < 20 ? 'низкий' : pct < 32 ? 'средний' : 'высокий';
  return '<span class="risk ' + cls + '">пираты ' + pct + '% · ' + word + '</span>';
}

function stagesHtml() {
  const leg = LEG[S.planet];
  const st = stats(S);
  const pirates = Math.round(pirateRisk(S) * 100);
  const sign = Math.round(signChance(S) * 100);
  const aboard = S.owned.length;
  const immune = S.owned.filter(id => CARD[id].yamauda).length;
  return '<div class="stages">' +
    '<div class="stage"><h3>Этап 1 · по планете ' + esc(PLANET[S.planet].name) + '</h3>' +
      '<div class="facts"><span>' + leg.days + ' дн. · ' + Math.round(flightMs(leg.days) / 1000) + ' с</span><span>топливо ' + Math.ceil(leg.fuel * st.fuelMul) + '</span>' + riskChip(pirates) + '</div>' + riskBar(pirates, pirates < 20 ? 'low' : pirates < 32 ? 'mid' : 'high') +
      '<small>Цеппель идёт к точке перехода. Пираты и грозы встречаются здесь, поэтому риск зависит от порта вылета и растёт со стоимостью груза.</small></div>' +
    '<div class="stage"><h3>Этап 2 · переход через Пустоту</h3>' +
      '<div class="facts"><span>мгновенно</span><span class="risk ' + (sign < 10 ? 'low' : sign < 15 ? 'mid' : 'high') + '">знак Пустоты ' + sign + '%</span></div>' + riskBar(sign, sign < 10 ? 'low' : sign < 15 ? 'mid' : 'high') +
      '<small>Цеппель сразу оказывается в порту назначения. Девять знаков из десяти зловещие: пропадает случайный член экипажа, если он не ямауда. На борту ' + aboard + ' чел., ямауда из них ' + immune + '.</small></div>' +
    '</div>';
}

function renderMap() {
  const here = PLANET[S.planet];
  const range = maxRange(S);
  let svg = '<svg viewBox="0 0 700 400" role="img" aria-label="Карта миров">';
  for (let x = 0; x <= 700; x += 70) svg += '<line class="m-grid" x1="' + x + '" y1="0" x2="' + x + '" y2="400"/>';
  for (let y = 0; y <= 400; y += 80) svg += '<line class="m-grid" x1="0" y1="' + y + '" x2="700" y2="' + y + '"/>';
  svg += '<circle class="m-range" cx="' + here.x + '" cy="' + here.y + '" r="' + range.toFixed(1) + '"/>';
  svg += '<text class="m-cap" x="10" y="392">пунктир: дальность перехода на остатке топлива</text>';
  if (selDest && PLANET[selDest] && selDest !== S.planet) {
    const d = PLANET[selDest];
    svg += '<line class="m-route" x1="' + here.x + '" y1="' + here.y + '" x2="' + d.x + '" y2="' + d.y + '"/>';
  }
  for (const p of PLANETS) {
    const cls = 'm-node' + (p.id === S.planet ? ' here' : '') + (p.id === selDest ? ' sel' : '');
    const anchor = p.x > 520 ? 'end' : 'start';
    const lx = p.x > 520 ? p.x - 16 : p.x + 16;
    svg += '<circle class="' + cls + '" data-act="pick" data-p="' + p.id + '" cx="' + p.x + '" cy="' + p.y + '" r="9"/>';
    svg += '<text class="m-label" text-anchor="' + anchor + '" x="' + lx + '" y="' + (p.y + 4) + '">' + esc(p.name) + '</text>';
  }
  svg += '</svg>';

  const list = PLANETS.filter(p => p.id !== S.planet).map(p => {
    const r = route(S, p.id);
    const ok = S.fuel >= r.fuel;
    return '<button class="dest' + (ok ? '' : ' far') + '" data-act="pick" data-p="' + p.id + '" aria-pressed="' + (p.id === selDest) + '">' +
      artImg('port-' + p.id, 'thumb', '') +
      '<span class="nm"><span>' + esc(p.name) + '</span><small>' + esc(p.kind) + '</small></span>' +
      '<span class="facts"><span>' + Math.round(r.dist) + ' ед.</span><span>топливо ' + r.fuel + ' из ' + S.fuel + '</span></span>' +
      '<div class="bar ' + (ok ? (r.fuel > S.fuel * 0.7 ? 'warn' : '') : 'crit') + '" aria-hidden="true"><i style="width:' + clamp(Math.round(r.fuel / Math.max(1, S.fuel) * 100), 0, 100) + '%"></i></div>' +
      '<span class="goodlist">Дёшево: <b>' + goodNames(p.cheap) + '</b></span>' +
      '<span class="goodlist">Спрос: <b>' + goodNames(p.dear) + '</b></span></button>';
  }).join('');

  let go = '<small>Выберите мир на карте или в списке.</small>';
  if (selDest && selDest !== S.planet) {
    const r = route(S, selDest);
    const ok = S.fuel >= r.fuel;
    go = '<div class="btnrow"><button class="btn primary" data-act="go"' + (ok ? '' : ' disabled') + '>Лететь в ' + esc(PLANET[selDest].name) + ' (' + Math.round(flightMs(r.days) / 1000) + ' с)</button></div>' +
      '<small>' + (ok ? 'Расход ' + r.fuel + ' топлива, ' + r.days + ' дн. по планете (на экране ' + Math.round(flightMs(r.days) / 1000) + ' с), жалованье команды ' + fmt(stats(S).wage * r.days) + '.' + (S.cash < stats(S).wage * r.days ? ' Денег на жалованье не хватает: самый дорогой член команды уйдёт.' : '') : 'Не хватает топлива: нужно ' + r.fuel + ', в баке ' + S.fuel + '. Заправьтесь на рынке.') + '</small>';
  }
  return '<section class="panel"><header><h2>Карта миров</h2><small>Вы в порту: ' + esc(here.name) + '</small></header>' +
    stagesHtml() + '<div class="mapbox">' + svg + '</div>' + go + '<div class="dest-list">' + list + '</div></section>';
}

function renderShip() {
  const st = stats(S);
  const stat = (l, v) => '<div class="stat"><div class="lab">' + l + '</div><div class="val">' + v + '</div></div>';
  const upg = Object.keys(UPGRADES).map(k => {
    const u = UPGRADES[k];
    const lvl = S.upg[k];
    const cost = upgradeCost(S, k);
    const maxed = lvl >= MAX_UPG;
    let pips = '';
    for (let i = 0; i < MAX_UPG; i++) pips += '<i class="' + (i < lvl ? 'on' : '') + '"></i>';
    return '<div class="upg"><h3>' + u.name + '</h3><small>' + u.unit + '</small><div class="pips" aria-label="Уровень ' + lvl + ' из ' + MAX_UPG + '">' + pips + '</div>' +
      '<button class="btn" data-act="upg" data-k="' + k + '"' + (maxed || S.cash < cost ? ' disabled' : '') + '>' + (maxed ? 'Максимум' : 'Улучшить за ' + fmt(cost)) + '</button></div>';
  }).join('');
  return '<section class="panel"><header><h2>Цеппелин</h2><small>Итоговые значения с учётом команды</small></header>' + artImg('ship', 'shiphero', 'Ваш цеппелин') +
    '<div class="statgrid">' +
      stat('Трюм', st.hold + ' ящ.') + stat('Бак', st.tank) + stat('Корпус', st.hullMax) + stat('Огневая мощь', st.guns) +
      stat('Дальность', Math.round(st.tank * 40 / st.fuelMul) + ' ед.') + stat('Расход топлива', Math.round(st.fuelMul * 100) + '%') +
      stat('Знаки Пустоты', Math.round(signChance(S) * 100) + '% за переход') + stat('Пираты при вылете', Math.round(pirateRisk(S) * 100) + '%') + stat('Урон по корпусу', Math.round(st.dmgMul * 100) + '%') +
      stat('Покупка', Math.round(st.buyMul * 100) + '%') + stat('Продажа', Math.round(st.sellMul * 100) + '%') +
      stat('Жалованье', st.wage + ' / день') +
    '</div>' +
    '<h2>Верфь</h2><div class="upgrades">' + upg + '</div></section>';
}

function cardHtml(c, actionHtml) {
  const rar = { common: 'обычная', rare: 'редкая', epic: 'легендарная' }[c.rarity];
  const pic = artImg('crew-' + c.id, 'pic', c.name);
  return '<div class="card ' + c.rarity + '"><div class="ctop">' + pic + '<div class="ctext"><span class="rar">' + rar + ' · ' + ROLES[c.role] + (c.yamauda ? ' · ямауда' : '') + '</span>' +
    '<span class="nm">' + c.name + '</span></div></div><span class="eff">' + describeEff(c.eff) + '</span>' +
    (c.yamauda ? '<span class="imm">Ямауда: невосприимчив к Знакам Пустоты, отличный цепарь</span>' : '') +
    '<span class="ln">' + c.line + '</span><small>жалованье ' + c.wage + ' / день</small>' + (actionHtml || '') + '</div>';
}

function renderCrew() {
  const slots = ROLE_ORDER.map(r => {
    const id = S.crew[r];
    return '<div><div class="slot-lab">' + ROLES[r] + '</div>' +
      (id ? cardHtml(CARD[id]) : '<div class="card empty"><span>Пост свободен</span><small>Наймите в таверне</small></div>') + '</div>';
  }).join('');
  const bench = S.owned.filter(id => S.crew[CARD[id].role] !== id).map(id =>
    cardHtml(CARD[id], '<div class="btnrow"><button class="btn" data-act="equip" data-c="' + id + '">Назначить на пост</button></div>')).join('');
  const tav = tavernList(S).map(c =>
    cardHtml(c, '<div class="btnrow"><button class="btn buy" data-act="hire" data-c="' + c.id + '"' + (S.cash < c.cost ? ' disabled' : '') + '>Нанять за ' + fmt(c.cost) + '</button></div>')).join('');
  return '<section class="panel"><header><h2>Команда</h2><small>По одному человеку на пост. Ямауда не боятся Знаков Пустоты и работают лучше других (эффект +10%), но астрологами быть не могут.</small></header>' +
    '<div class="slots">' + slots + '</div>' +
    (bench ? '<h2>В запасе</h2><div class="cards">' + bench + '</div>' : '') +
    '<h2>Таверна: ' + esc(PLANET[S.planet].name) + '</h2>' +
    (tav ? '<div class="cards">' + tav + '</div>' : '<p class="lead">Свободных людей нет: вся команда уже у вас.</p>') +
    '<small>Состав таверны меняется каждые 8 дней и зависит от порта.</small></section>';
}

function renderRank() {
  const mine = netWorth(S);
  let board = '';
  if (net.mode === 'online') {
    const rows = net.board.length ? net.board : [];
    board = rows.length
      ? '<div class="board">' + rows.map((r, i) =>
          '<div class="brow' + (r.id === net.uid ? ' me' : '') + '"><span class="pos">' + (i + 1) + '</span><span class="who">' + esc(r.name || 'Без имени') + ' <small>день ' + esc(r.day || 0) + (r.over ? ' · банкрот' : '') + '</small></span><b class="mono">' + fmt(Number(r.peak) || Number(r.worth) || 0) + '</b></div>').join('') + '</div>'
      : '<p class="lead">Пока никого нет. Ваш результат появится после первой сделки.</p>';
  } else {
    board = '<p class="lead">Сетевой рейтинг и общий рынок включаются, когда страница открыта с правами участника. Сейчас игра идёт автономно, прогресс хранится в этом браузере.</p>';
  }
  return '<section class="panel"><header><h2>Рейтинг пилотов</h2><small>Мерило: лучший капитал за всю карьеру</small></header>' +
    '<div class="field"><label for="pname" class="small">Имя капитана</label><input id="pname" maxlength="24" value="' + esc(S.name) + '"></div>' +
    '<div class="statgrid"><div class="stat"><div class="lab">Ваш капитал</div><div class="val">' + fmt(mine) + '</div></div>' +
    '<div class="stat"><div class="lab">Лучший капитал</div><div class="val">' + fmt(Math.max(S.stats.peak || 0, net.bestPeak || 0)) + '</div></div></div>' +
    board +
    '<small>Рейсов: ' + S.stats.trips + ' · прибыль со сделок: ' + fmt(S.stats.profit) + ' · стычек с пиратами: ' + S.stats.pirates + ' · крушений: ' + S.stats.wrecks + ' · ушло из команды: ' + (S.stats.deserted || 0) + ' · потеряно в Пустоте: ' + (S.stats.voidLost || 0) + '</small>' +
    '<div class="btnrow">' + (confirmReset
      ? '<button class="btn danger" data-act="reset-yes">Да, начать заново</button><button class="btn" data-act="reset-no">Отмена</button>'
      : '<button class="btn" data-act="reset">Новая игра</button>') + '</div></section>';
}

function render() {
  renderNet();
  renderGauges();
  renderTabs();
  const v = $('#view');
  const active = document.activeElement;
  const keepName = active && active.id === 'pname';
  if (keepName) return; // не перерисовываем поле во время ввода
  v.innerHTML = { market: renderMarket, map: renderMap, ship: renderShip, crew: renderCrew, rank: renderRank }[tab]();
  renderLog();
  if (trade) updateTrade();
}

// ---------- пираты ----------
function showPirates() {
  const ev = S.flight.ev;
  const o = pirateOptions(S, ev);
  $('#modal').hidden = false;
  $('#modal').innerHTML = '<div class="box" role="dialog" aria-modal="true" aria-labelledby="mt">' + artImg('ev-pirates', 'evimg', '') +
    '<h2 id="mt">Пираты по курсу</h2>' +
    '<p style="margin:0">Лёгкие корветы заходят с наветренной стороны. Сила налётчиков: ' + ev.strength + '. Нужна огневая мощь не меньше ' + o.need + '.</p>' +
    '<div class="odds">Ваша огневая мощь: ' + o.guns + ' · шанс выиграть бой: ' + fightOdds(o) + '%<br>Проигрыш: урон корпусу, почти половина груза и десятая часть казны уходят пиратам.</div>' +
    '<div class="btnrow"><button class="btn primary" data-act="pirate" data-c="fight">Принять бой</button>' +
    '<button class="btn" data-act="pirate" data-c="pay"' + (o.canPay ? '' : ' disabled') + '>Откупиться за ' + fmt(o.tribute) + '</button></div></div>';
  const first = $('#modal .btn.primary');
  if (first) first.focus();
}

// ---------- диалог сделки со слайдером ----------
let trade = null; // { mode: 'buy' | 'sell', g, n }

function tradeLimits(mode, g) {
  const q = quote(S, store, S.planet, g);
  if (mode === 'buy') {
    const free = stats(S).hold - cargoCount(S);
    return { q, max: Math.max(0, Math.min(free, Math.floor(S.cash / q.buy))) };
  }
  return { q, max: S.hold[g] || 0 };
}

function showTrade(mode, g) {
  const lim = tradeLimits(mode, g);
  if (lim.max <= 0) return;
  trade = { mode, g, n: mode === 'buy' ? Math.min(lim.max, Math.max(1, Math.ceil(lim.max / 2))) : lim.max };
  const buying = mode === 'buy';
  $('#modal').hidden = false;
  $('#modal').innerHTML = '<div class="box ' + (buying ? 'is-buy' : 'is-sell') + '" role="dialog" aria-modal="true" aria-labelledby="tt">' +
    '<h2 id="tt">' + (buying ? 'Купить' : 'Продать') + ': ' + GOOD[g].name + '</h2>' +
    '<div class="qty"><b class="mono" id="tn" aria-live="polite"></b><span class="small" id="tof"></span></div>' +
    '<div class="slider">' +
      '<button class="btn" data-act="trade-set" data-v="-" aria-label="Меньше на один">−</button>' +
      '<input id="tqty" type="range" min="1" max="' + lim.max + '" step="1" value="' + trade.n + '" aria-label="Количество ящиков">' +
      '<button class="btn" data-act="trade-set" data-v="+" aria-label="Больше на один">+</button>' +
    '</div>' +
    '<div class="btnrow"><button class="btn" data-act="trade-set" data-v="min">Мин</button><button class="btn" data-act="trade-set" data-v="half">Половина</button><button class="btn" data-act="trade-set" data-v="max">Макс</button></div>' +
    '<div class="sum" id="tsum"></div>' +
    '<div class="btnrow"><button class="btn primary" data-act="trade-ok" id="tok"></button><button class="btn" data-act="trade-cancel">Отмена</button></div></div>';
  updateTrade();
  const r = $('#tqty'); if (r) r.focus();
}

function updateTrade() {
  if (!trade || $('#tqty') === null) return;
  const lim = tradeLimits(trade.mode, trade.g);
  if (lim.max <= 0) { hideModal(); return; }
  const n = clamp(Math.round(trade.n), 1, lim.max);
  trade.n = n;
  const r = $('#tqty');
  r.max = String(lim.max);
  r.value = String(n);
  const q = lim.q;
  $('#tn').textContent = n + ' ящ.';
  $('#tof').textContent = ' из ' + lim.max + (trade.mode === 'buy' ? ' (по деньгам и месту в трюме)' : ' в трюме');
  let html;
  if (trade.mode === 'buy') {
    const total = n * q.buy;
    html = '<div><span>Цена за ящик</span><b class="mono">' + fmt(q.buy) + '</b></div>' +
      '<div><span>Итого</span><b class="mono">' + fmt(total) + '</b></div>' +
      '<div><span>Казна после</span><b class="mono">' + fmt(S.cash - total) + '</b></div>' +
      '<small>Каждый купленный ящик поднимает цену покупки здесь примерно на 1%.</small>';
    $('#tok').textContent = 'Купить за ' + fmt(total);
  } else {
    const have = S.hold[trade.g] || 0;
    const revenue = n * q.sell;
    const cost = have ? (S.basis[trade.g] || 0) * (n / have) : 0;
    const profit = Math.round(revenue - cost);
    html = '<div><span>Цена за ящик</span><b class="mono">' + fmt(q.sell) + '</b></div>' +
      '<div><span>Выручка</span><b class="mono">' + fmt(revenue) + '</b></div>' +
      '<div><span>Относительно закупки</span><b class="mono ' + (profit >= 0 ? 'gain' : 'loss') + '">' + (profit >= 0 ? '+' : '−') + fmt(Math.abs(profit)) + '</b></div>' +
      '<small>Каждый проданный ящик опускает цену продажи здесь примерно на 1%.</small>';
    $('#tok').textContent = 'Продать за ' + fmt(revenue);
  }
  $('#tsum').innerHTML = html;
}

function showOver() {
  trade = null;
  const o = S.over || {};
  $('#modal').hidden = false;
  $('#modal').innerHTML = '<div class="box is-over" role="alertdialog" aria-modal="true" aria-labelledby="ot">' + artImg('ev-bankrupt', 'evimg', '') +
    '<h2 id="ot">Банкротство</h2>' +
    '<p style="margin:0">Казны и груза не хватает, чтобы продолжать рейсы. Кредиторы описали цеппелин на причале ' + esc(PLANET[S.planet].name) + '.</p>' +
    '<div class="sum"><div><span>Дней в пути</span><b class="mono">' + fmt(o.day || S.day) + '</b></div>' +
    '<div><span>Рейсов</span><b class="mono">' + fmt(S.stats.trips) + '</b></div>' +
    '<div><span>Лучший капитал</span><b class="mono">' + fmt(Math.max(S.stats.peak || 0, net.bestPeak || 0)) + '</b></div></div>' +
    '<div class="btnrow"><button class="btn primary" data-act="restart">Начать заново</button></div></div>';
  const b = $('#modal .btn.primary'); if (b) b.focus();
}

function showSign(sign) {
  trade = null;
  const cls = sign.bad ? (sign.lost ? 'is-over' : 'is-sell') : 'is-buy';
  const title = !sign.bad ? 'Благой знак Пустоты' : sign.lost ? 'Зловещий знак Пустоты' : sign.immune ? 'Знак Пустоты не тронул экипаж' : 'Знак Пустоты';
  $('#modal').hidden = false;
  $('#modal').innerHTML = '<div class="box ' + cls + '" role="alertdialog" aria-modal="true" aria-labelledby="st">' + artImg(sign.bad ? 'ev-sign-bad' : 'ev-sign-good', 'evimg', '') +
    '<h2 id="st">' + esc(title) + '</h2><p style="margin:0">' + esc(sign.text) + '</p>' +
    '<div class="btnrow"><button class="btn primary" data-act="ack">Продолжить</button></div></div>';
  const b = $('#modal .btn.primary'); if (b) b.focus();
}

// ---------- перелёт: пауза 15 с на день ----------
const SHIP_SVG = '<svg class="shipsvg" viewBox="0 0 240 100" aria-hidden="true">' +
  '<ellipse class="env" cx="120" cy="38" rx="100" ry="30"/>' +
  '<path class="rib" d="M60 12 Q52 38 60 64 M90 9 Q82 38 90 67 M120 8 Q112 38 120 68 M150 9 Q142 38 150 67 M180 12 Q172 38 180 64"/>' +
  '<path class="fin" d="M30 24 L6 6 L24 38 Z M30 52 L6 70 L24 40 Z"/>' +
  '<path class="strut" d="M105 66 L108 74 M135 66 L132 74"/>' +
  '<rect class="gon" x="94" y="74" width="52" height="14" rx="5"/>' +
  '<ellipse class="prop" cx="154" cy="81" rx="3" ry="12"/></svg>';

function buildFlightBox() {
  const f = S.flight;
  const sky = ART.sky
    ? '<div class="track">' + [0, 1, 2, 3].map(i => '<img class="art' + (i % 2 ? ' flip' : '') + '" src="' + ART.sky + '" alt="">').join('') + '</div>'
    : '<div class="clouds c1"></div><div class="clouds c2"></div>';
  const ship = ART.ship ? '<img class="art flyimg" src="' + ART.ship + '" alt="">' : SHIP_SVG;
  $('#modal').hidden = false;
  $('#modal').innerHTML = '<div class="box flightbox" role="status">' +
    '<div class="sky">' + sky + '<div class="flyer">' + ship + '</div></div>' +
    '<h2>В пути: ' + esc(PLANET[S.planet].name) + ' → ' + esc(PLANET[f.dest].name) + '</h2>' +
    '<div class="bar"><i id="fl-bar" style="width:0%"></i></div>' +
    '<div class="fl-meta"><span id="fl-stage"></span><b class="mono" id="fl-left"></b></div>' +
    '<small>' + f.days + ' дн. по планете, на экране ' + Math.round(flightMs(f.days) / 1000) + ' с. Затем мгновенный переход через Пустоту.</small></div>';
}

function tickFlight() {
  const f = S.flight;
  if (!f) { stopFlight(); return; }
  const eta = f.eta != null ? f.eta : 0;
  const total = Math.max(1, eta - (f.t0 != null ? f.t0 : eta - 1));
  const left = Math.max(0, eta - Date.now());
  const pct = clamp(1 - left / total, 0, 1);
  const bar = $('#fl-bar');
  if (bar) bar.style.width = Math.round(pct * 100) + '%';
  const lt = $('#fl-left');
  if (lt) lt.textContent = Math.ceil(left / 1000) + ' с';
  const stg = $('#fl-stage');
  if (stg) stg.textContent = pct < 0.85 ? 'Идём по планете к точке перехода' : 'Подходим к точке перехода';
  if (left <= 0) { stopFlight(); landFlight(); }
}

function stopFlight() { if (flightTimer) { clearInterval(flightTimer); flightTimer = null; } }

function startFlightUI() {
  if (!S.flight || flightTimer) return;
  buildFlightBox();
  flightTimer = setInterval(tickFlight, 200);
  tickFlight();
}

function landFlight() {
  const r = completeFlight(S);
  hideModal();
  selDest = null; tab = 'market';
  if (r.pending) { writeSave(); render(); return showPirates(); }
  return after(r);
}

function startNew() {
  const name = S.name;
  S = newGame(name);
  confirmReset = false; selDest = null; tab = 'market';
  net.lastScore = '';
  hideModal();
  return after({ ok: true });
}

function hideModal() { trade = null; $('#modal').hidden = true; $('#modal').innerHTML = ''; }

// ---------- события ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-tab],[data-act]');
  if (!t) return;
  if (t.dataset.tab) {
    tab = t.dataset.tab;
    confirmReset = false;
    render();
    return;
  }
  const a = t.dataset.act;
  switch (a) {
    case 'trade': return showTrade(t.dataset.m, t.dataset.g);
    case 'trade-set': {
      if (!trade) return;
      const max = tradeLimits(trade.mode, trade.g).max;
      const v = t.dataset.v;
      trade.n = v === '-' ? trade.n - 1 : v === '+' ? trade.n + 1 : v === 'min' ? 1 : v === 'half' ? Math.ceil(max / 2) : max;
      return updateTrade();
    }
    case 'trade-ok': {
      if (!trade) return;
      const { mode, g, n } = trade;
      hideModal();
      return after(mode === 'buy' ? buy(S, store, g, n) : sell(S, store, g, n));
    }
    case 'trade-cancel': return hideModal();
    case 'refuel': return after(refuel(S, 999));
    case 'repair': return after(repair(S, 999));
    case 'upg': return after(upgrade(S, t.dataset.k));
    case 'hire': return after(hire(S, t.dataset.c));
    case 'equip': return after(equip(S, t.dataset.c));
    case 'pick': selDest = t.dataset.p === S.planet ? null : t.dataset.p; return render();
    case 'go': {
      bulletin = null;
      const r = depart(S, selDest, { now: Date.now() });
      if (!r.ok) return after(r);
      writeSave();
      render();
      return startFlightUI();
    }
    case 'bulletin-x': bulletin = null; return render();
    case 'pirate': {
      hideModal();
      const r = resolveFlight(S, t.dataset.c);
      selDest = null; tab = 'market';
      return after(r);
    }
    case 'ack': hideModal(); return render();
    case 'reset': confirmReset = true; return render();
    case 'reset-no': confirmReset = false; return render();
    case 'reset-yes': return startNew();
    case 'restart': return startNew();
  }
});

document.addEventListener('input', e => {
  if (e.target && e.target.id === 'tqty' && trade) {
    trade.n = Number(e.target.value);
    updateTrade();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && trade) hideModal();
});
$('#modal').addEventListener('click', e => {
  if (trade && e.target === $('#modal')) hideModal();
});

document.addEventListener('change', e => {
  if (e.target && e.target.id === 'pname') {
    S.name = (e.target.value || '').trim().slice(0, 24) || S.name;
    writeSave();
    scheduleScore();
    render();
  }
});
document.addEventListener('focusout', e => {
  if (e.target && e.target.id === 'pname') setTimeout(render, 0);
});

// тема: переключатель в шапке; без выбора игрока тема следует системной
const THEME_KEY = 'mg-theme';
function setTheme(dark, save) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme').setAttribute('aria-checked', String(dark));
  if (save) { try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {} }
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (saved) setTheme(saved === 'dark', false);
  else $('#theme').setAttribute('aria-checked', String(!!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)));
  $('#theme').addEventListener('click', () => setTheme($('#theme').getAttribute('aria-checked') !== 'true', true));
}

// ---------- запуск ----------
(function init() {
  initTheme();
  $('#banner').innerHTML = artImg('banner', 'banner-img', 'Медный Горизонт');
  render();
  if (S.flight) {
    if (S.flight.ev && S.flight.ev.type === 'pirates') showPirates();
    else if (S.flight.eta != null) startFlightUI();   // рейс идёт: продолжаем отсчёт или сразу садимся
    else S.flight = null;
  }
  if (S.over) showOver();
  goOnline();
})();
