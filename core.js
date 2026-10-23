// ============================================================
// ЯДРО ИГРЫ — чистая логика без DOM и без сети.
// Всё, что видит интерфейс, идёт через функции ниже.
// Всё, что может быть общим для игроков (давление на цены, рейтинг),
// идёт через PressureStore и Backend (см. app.js).
// ============================================================

const SAVE_KEY = 'paroviy-torg-v4';
const PRESSURE_STEP = 0.01;           // сдвиг цены за единицу товара в сделке
const PRESSURE_MIN = -0.35;
const PRESSURE_MAX = 0.6;
const PRESSURE_HALF_LIFE_MS = 15 * 60 * 1000; // давление рынка убывает вдвое за 15 минут
const FUEL_PRICE = 8;
const REPAIR_PRICE = 8;
const MAX_UPG = 5;
const START_CASH = 1200;
const YAMAUDA_BONUS = 1.1;   // ямауда считаются отличными цепарями: эффект карты выше на 10%
const WAGE_MUL = 1.5;        // множитель жалованья команды
// Пауза на перелёт: на каждый игровой день планетного этапа приходится столько реальных миллисекунд.
let FLIGHT_MS_PER_DAY = 15000;
function setFlightPace(ms) { FLIGHT_MS_PER_DAY = ms; }
function flightMs(days) { return days * FLIGHT_MS_PER_DAY; }

const SIGN_BASE = 0.14;      // шанс Знака Пустоты при переходе (до влияния астролога)
const SIGN_BAD = 0.9;        // из них зловещих
const BANKRUPT_FLOOR = 60;   // меньше этой ликвидности (казна + груз по минимуму) — банкротство

const GOODS = [
  { id: 'coal',      name: 'Уголь',          base: 20 },
  { id: 'food',      name: 'Провиант',       base: 30 },
  { id: 'cloth',     name: 'Ткани',          base: 45 },
  { id: 'boilers',   name: 'Паровые котлы',  base: 70 },
  { id: 'spice',     name: 'Специи',         base: 90 },
  { id: 'med',       name: 'Лекарства',      base: 110 },
  { id: 'arms',      name: 'Оружие',         base: 130 },
  { id: 'metal',     name: 'Редкие металлы', base: 170 },
  { id: 'blueprint', name: 'Чертежи',        base: 210 },
  { id: 'relic',     name: 'Реликвии',       base: 260 },
];
const GOOD = Object.fromEntries(GOODS.map(g => [g.id, g]));

// Заграта и Ахадир взяты из книг (описание сведено к тому, что известно наверняка).
// Остальные миры придуманы для прототипа: замените на канонические в этом списке.
const PLANETS = [
  { id: 'zagrata', name: 'Заграта', x: 90, y: 215, kind: 'Индустриальный мир', canon: true,
    desc: 'Шахты и верфи. Гражданская война держит спрос на оружие, лекарства и провиант.',
    cheap: ['coal', 'boilers'], dear: ['arms', 'med', 'food'] },
  { id: 'tarnok', name: 'Тарнок', x: 255, y: 95, kind: 'Мастеровой узел',
    desc: 'Литейные и оружейные цеха. Здесь делают сами, а вот пряности и еду везут издалека.',
    cheap: ['boilers', 'arms'], dear: ['spice', 'food', 'metal'] },
  { id: 'ahadir', name: 'Ахадир', x: 565, y: 70, kind: 'Священный мир', canon: true,
    desc: 'Паломники и храмовые лавки. Реликвии и специи дёшевы, лекарства и ткани нужны всегда.',
    cheap: ['relic', 'spice'], dear: ['med', 'cloth'] },
  { id: 'velmar', name: 'Порт Вельмар', x: 335, y: 320, kind: 'Портовый город',
    desc: 'Рыбные причалы и текстильные склады. Металл и чертежи уходят отсюда втридорога.',
    cheap: ['food', 'cloth'], dear: ['metal', 'coal', 'blueprint'] },
  { id: 'eltram', name: 'Эльтрам', x: 445, y: 180, kind: 'Город-университет',
    desc: 'Лаборатории и библиотеки. Чертежи и лекарства дёшевы, учёные платят за реликвии.',
    cheap: ['blueprint', 'med'], dear: ['boilers', 'relic', 'spice'] },
  { id: 'seryi', name: 'Серый Предел', x: 615, y: 305, kind: 'Рудная окраина',
    desc: 'Рудники на краю карты. Металл почти даром, всё остальное завозное.',
    cheap: ['metal', 'coal'], dear: ['med', 'food', 'blueprint'] },
];
const PLANET = Object.fromEntries(PLANETS.map(p => [p.id, p]));

// Цепарь в лоре любой член экипажа цеппеля, поэтому отдельного поста для него нет:
// им является каждая карта в команде.
const ROLES = {
  ast: 'Астролог',
  eng: 'Инженер',
  gun: 'Канонир',
  qm:  'Квартирмейстер',
};
const ROLE_ORDER = ['ast', 'eng', 'gun', 'qm'];

// yamauda: врождённый иммунитет к Пустоте и Знакам Пустоты. Астрологами ямауда быть не могут,
// зато из них выходят отличные цепари: их эффект выше на YAMAUDA_BONUS.
const CARDS = [
  { id: 'ast1', role: 'ast', rarity: 'common', name: 'Ирма Вейс',    cost: 250,  wage: 3,  eff: { fuel: -0.10, sign: -0.15 }, line: 'Считает переходы по таблицам и не ошибается.' },
  { id: 'ast2', role: 'ast', rarity: 'rare',   name: 'Ортан Бэй',    cost: 700,  wage: 8,  eff: { fuel: -0.18, sign: -0.30 }, line: 'Чувствует астринг как собственную руку.' },
  { id: 'ast3', role: 'ast', rarity: 'epic',   name: 'Мирра Каст',   cost: 1600, wage: 14, eff: { fuel: -0.25, sign: -0.45 }, line: 'Пустота для неё открытая книга.' },
  { id: 'eng1', role: 'eng', rarity: 'common', name: 'Бруно Каль',   cost: 250,  wage: 3,  eff: { hull: 8,  dmg: -0.15 },     line: 'Чинит котёл гаечным ключом и руганью.' },
  { id: 'eng2', role: 'eng', rarity: 'rare',   name: 'Тесса Грапп',  cost: 700,  wage: 8,  eff: { hull: 16, dmg: -0.30 }, yamauda: true, line: 'Усиливает шпангоуты на лету, а Пустота ей нипочём.' },
  { id: 'eng3', role: 'eng', rarity: 'epic',   name: 'Мастер Йонас', cost: 1600, wage: 14, eff: { hull: 26, dmg: -0.45 }, yamauda: true, line: 'Корпус под его рукой не сдаётся.' },
  { id: 'gun1', role: 'gun', rarity: 'common', name: 'Рик Шаттер',   cost: 250,  wage: 3,  eff: { guns: 1 },                  line: 'Целится в то, что движется.' },
  { id: 'gun2', role: 'gun', rarity: 'rare',   name: 'Сестра Ольга', cost: 700,  wage: 8,  eff: { guns: 2 },                  line: 'Молится и стреляет без промаха.' },
  { id: 'gun3', role: 'gun', rarity: 'epic',   name: 'Старый Валь',  cost: 1600, wage: 14, eff: { guns: 3 },                  line: 'Три войны и ни одного пропущенного залпа.' },
  { id: 'qm1',  role: 'qm',  rarity: 'common', name: 'Пим Торгс',    cost: 250,  wage: 3,  eff: { hold: 3,  sell: 0.02 },     line: 'Умеет втиснуть лишний ящик.' },
  { id: 'qm2',  role: 'qm',  rarity: 'rare',   name: 'Даша Колман',  cost: 700,  wage: 8,  eff: { hold: 6,  buy: -0.03, sell: 0.03 }, yamauda: true, line: 'Торгуется до последнего гроша.' },
  { id: 'qm3',  role: 'qm',  rarity: 'epic',   name: 'Барон Силь',   cost: 1600, wage: 14, eff: { hold: 10, buy: -0.05, sell: 0.05 }, yamauda: true, line: 'Его улыбка стоит процента с каждой сделки.' },
];
CARDS.forEach(c => {
  if (!c.yamauda) return;
  for (const k of Object.keys(c.eff)) {
    const v = c.eff[k] * YAMAUDA_BONUS;
    c.eff[k] = Number.isInteger(c.eff[k]) ? Math.round(v) : Math.round(v * 100) / 100;
  }
});
CARDS.forEach(c => { c.wage = Math.round(c.wage * WAGE_MUL); });
const CARD = Object.fromEntries(CARDS.map(c => [c.id, c]));

const UPGRADES = {
  hold: { name: 'Грузовой отсек',   unit: '+5 ящиков к трюму',   base: 400 },
  tank: { name: 'Топливный бак',    unit: '+5 к запасу топлива', base: 300 },
  hull: { name: 'Броня корпуса',    unit: '+10 к прочности',     base: 350 },
  gun:  { name: 'Орудийная палуба', unit: '+1 к огневой мощи',   base: 600 },
};

// ---------- утилиты ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function rnd(s) { // mulberry32 поверх состояния игры
  s.seed = (s.seed + 0x6D2B79F5) | 0;
  let t = s.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------- состояние ----------
function newGame(name) {
  const s = {
    v: 1,
    name: name || ('Капитан-' + (100 + Math.floor(Math.random() * 900))),
    day: 0,
    cash: START_CASH,
    planet: 'zagrata',
    fuel: 30,
    hull: 48,
    hold: {},
    basis: {},
    upg: { hold: 0, tank: 0, hull: 0, gun: 0 },
    crew: { ast: 'ast1', eng: 'eng1', gun: 'gun1', qm: null },
    owned: ['ast1', 'eng1', 'gun1'],
    seed: (Date.now() & 0x7fffffff) | 1,
    flight: null,
    log: [{ d: 0, t: 'Цеппелин на причальной мачте. Трюм пуст, казна ' + START_CASH + '. Долгов нет и помощи ждать не от кого.' }],
    stats: { trips: 0, profit: 0, pirates: 0, wrecks: 0, peak: START_CASH, deserted: 0, voidLost: 0, signs: 0 },
    over: null,
  };
  s.hull = stats(s).hullMax;
  return s;
}

function note(s, text) {
  s.log.push({ d: s.day, t: text });
  if (s.log.length > 40) s.log.shift();
  return text;
}

function equipped(s) {
  return ROLE_ORDER.map(r => s.crew[r]).filter(Boolean).map(id => CARD[id]);
}

function stats(s) {
  const c = equipped(s);
  const sum = k => c.reduce((a, x) => a + (x.eff[k] || 0), 0);
  return {
    hold: 15 + s.upg.hold * 5 + sum('hold'),
    tank: 30 + s.upg.tank * 5,
    hullMax: 40 + s.upg.hull * 10 + sum('hull') + 8, // +8: базовая обшивка
    guns: 1 + s.upg.gun + sum('guns'),
    fuelMul: Math.max(0.5, 1 + sum('fuel')),
    signMul: Math.max(0.3, 1 + sum('sign')),
    dmgMul: Math.max(0.3, 1 + sum('dmg')),
    buyMul: 1 + sum('buy'),
    sellMul: 0.92 + sum('sell'),
    wage: c.reduce((a, x) => a + x.wage, 0),
  };
}

function cargoCount(s) {
  return Object.values(s.hold).reduce((a, n) => a + n, 0);
}

function netWorth(s) {
  let w = s.cash;
  for (const [g, n] of Object.entries(s.hold)) w += Math.round(n * GOOD[g].base * 0.9);
  return Math.round(w);
}

// ---------- рынок ----------
class PressureStore {
  constructor(now) {
    this.docs = {};
    this.now = now || (() => Date.now());
    this.onWrite = null;
  }
  get(key) {
    const d = this.docs[key];
    if (!d) return 0;
    return d.p * Math.pow(0.5, (this.now() - d.t) / PRESSURE_HALF_LIFE_MS);
  }
  // Давление хранится отдельно для покупки (ключ _b, от 0 вверх) и продажи (ключ _s, от 0 вниз).
  // Покупка поднимает только цену покупки, продажа опускает только цену продажи.
  add(key, delta) {
    const range = pressureRange(key);
    if (!range) return 0;
    const [lo, hi] = range;
    const p = clamp(this.get(key) + delta, lo, hi);
    const d = { p: Math.round(p * 10000) / 10000, t: this.now() };
    this.docs[key] = d;
    if (this.onWrite) this.onWrite(key, d);
    return p;
  }
  ingest(key, d) {
    if (d && typeof d.p === 'number' && typeof d.t === 'number' && isFinite(d.p) && isFinite(d.t)) {
      const range = pressureRange(key);
      if (!range) return; // чужие и устаревшие ключи игнорируем
      this.docs[key] = { p: clamp(d.p, range[0], range[1]), t: d.t };
    }
  }
}

const pkey = (planetId, goodId, dir) => planetId + '_' + goodId + '_' + dir; // dir: 'b' или 's'
function pressureRange(key) {
  if (key.endsWith('_b')) return [0, PRESSURE_MAX];
  if (key.endsWith('_s')) return [PRESSURE_MIN, 0];
  return null;
}

function priceFactor(planetId, goodId) {
  const p = PLANET[planetId];
  if (p.cheap.includes(goodId)) return 0.72;
  if (p.dear.includes(goodId)) return 1.38;
  return 1.0;
}

function noise(planetId, goodId, day) {
  const bucket = Math.floor(day / 4);
  const a = hashStr(planetId + '|' + goodId + '|' + bucket);
  const b = hashStr(planetId + '|' + goodId + '|' + (bucket + 1));
  const f = (day % 4) / 4;
  return 0.9 + 0.2 * (a + (b - a) * f);
}

function quote(s, store, planetId, goodId) {
  const st = stats(s);
  const pb = store ? store.get(pkey(planetId, goodId, 'b')) : 0; // >= 0
  const ps = store ? store.get(pkey(planetId, goodId, 's')) : 0; // <= 0
  const mid = GOOD[goodId].base * priceFactor(planetId, goodId) * noise(planetId, goodId, s.day);
  return {
    mid,
    buy: Math.max(1, Math.round(mid * (1 + pb) * st.buyMul)),
    sell: Math.max(1, Math.round(mid * (1 + ps) * st.sellMul)),
    ratio: mid / GOOD[goodId].base,
    pb,
    ps,
  };
}

function buy(s, store, goodId, n) {
  if (s.over) return { ok: false, msg: 'Игра окончена.' };
  const st = stats(s);
  const q = quote(s, store, s.planet, goodId);
  const free = st.hold - cargoCount(s);
  if (free <= 0) return { ok: false, msg: 'Трюм полон.' };
  const afford = Math.floor(s.cash / q.buy);
  if (afford <= 0) return { ok: false, msg: 'Не хватает денег.' };
  n = Math.min(n, free, afford);
  if (n <= 0) return { ok: false, msg: 'Нечего покупать.' };
  const cost = n * q.buy;
  s.cash -= cost;
  s.hold[goodId] = (s.hold[goodId] || 0) + n;
  s.basis[goodId] = (s.basis[goodId] || 0) + cost;
  if (store) store.add(pkey(s.planet, goodId, 'b'), n * PRESSURE_STEP);
  note(s, 'Куплено: ' + GOOD[goodId].name + ' ×' + n + ' по ' + q.buy + '.');
  return { ok: true, n, price: q.buy, cost };
}

function sell(s, store, goodId, n) {
  if (s.over) return { ok: false, msg: 'Игра окончена.' };
  const have = s.hold[goodId] || 0;
  n = Math.min(n, have);
  if (n <= 0) return { ok: false, msg: 'Нечего продавать.' };
  const q = quote(s, store, s.planet, goodId);
  const revenue = n * q.sell;
  const cost = (s.basis[goodId] || 0) * (n / have);
  s.cash += revenue;
  s.hold[goodId] = have - n;
  s.basis[goodId] = Math.max(0, (s.basis[goodId] || 0) - cost);
  if (s.hold[goodId] <= 0) { delete s.hold[goodId]; delete s.basis[goodId]; }
  const profit = Math.round(revenue - cost);
  s.stats.profit += profit;
  if (store) store.add(pkey(s.planet, goodId, 's'), -n * PRESSURE_STEP);
  note(s, 'Продано: ' + GOOD[goodId].name + ' ×' + n + ' по ' + q.sell + ' (' + (profit >= 0 ? '+' : '') + profit + ').');
  return { ok: true, n, price: q.sell, revenue, profit };
}

function refuel(s, n) {
  const st = stats(s);
  n = Math.min(n, st.tank - s.fuel, Math.floor(s.cash / FUEL_PRICE));
  if (n <= 0) return { ok: false, msg: s.fuel >= st.tank ? 'Бак полон.' : 'Не хватает денег.' };
  s.cash -= n * FUEL_PRICE;
  s.fuel += n;
  note(s, 'Заправка: +' + n + ' топлива за ' + n * FUEL_PRICE + '.');
  return { ok: true, n };
}

function repair(s, n) {
  const st = stats(s);
  n = Math.min(n, st.hullMax - s.hull, Math.floor(s.cash / REPAIR_PRICE));
  if (n <= 0) return { ok: false, msg: s.hull >= st.hullMax ? 'Корпус цел.' : 'Не хватает денег.' };
  s.cash -= n * REPAIR_PRICE;
  s.hull += n;
  note(s, 'Ремонт: +' + n + ' прочности за ' + n * REPAIR_PRICE + '.');
  return { ok: true, n };
}

// ---------- улучшения и команда ----------
function upgradeCost(s, kind) {
  return UPGRADES[kind].base * (s.upg[kind] + 1);
}

function upgrade(s, kind) {
  if (s.upg[kind] >= MAX_UPG) return { ok: false, msg: 'Максимальный уровень.' };
  const cost = upgradeCost(s, kind);
  if (s.cash < cost) return { ok: false, msg: 'Не хватает денег.' };
  s.cash -= cost;
  s.upg[kind]++;
  note(s, 'Улучшение: ' + UPGRADES[kind].name + ' — уровень ' + s.upg[kind] + '.');
  return { ok: true, cost };
}

function tavernList(s) {
  const bucket = Math.floor(s.day / 8);
  return CARDS
    .filter(c => !s.owned.includes(c.id))
    .map(c => ({ c, h: hashStr(s.planet + '|' + bucket + '|' + c.id) }))
    .sort((a, b) => a.h - b.h)
    .slice(0, 3)
    .map(x => x.c);
}

function hire(s, cardId) {
  const c = CARD[cardId];
  if (!c || s.owned.includes(cardId)) return { ok: false, msg: 'Уже в команде.' };
  if (!tavernList(s).some(x => x.id === cardId)) return { ok: false, msg: 'В таверне его уже нет.' };
  if (s.cash < c.cost) return { ok: false, msg: 'Не хватает денег.' };
  s.cash -= c.cost;
  s.owned.push(cardId);
  if (!s.crew[c.role]) s.crew[c.role] = cardId;
  note(s, 'В команду нанят: ' + c.name + ' (' + ROLES[c.role] + ').');
  return { ok: true };
}

function equip(s, cardId) {
  const c = CARD[cardId];
  if (!c || !s.owned.includes(cardId)) return { ok: false, msg: 'Этого человека нет в команде.' };
  s.crew[c.role] = cardId;
  const st = stats(s);
  s.hull = Math.min(s.hull, st.hullMax);
  note(s, c.name + ' теперь на посту: ' + ROLES[c.role] + '.');
  trimCargo(s);
  return { ok: true };
}

// Если трюм сжался (ушёл квартирмейстер), лишние ящики выбрасываются, дешёвые первыми.
function trimCargo(s) {
  const st = stats(s);
  let over = cargoCount(s) - st.hold;
  if (over <= 0) return 0;
  const dropped = over;
  const order = Object.keys(s.hold).sort((a, b) => GOOD[a].base - GOOD[b].base);
  for (const g of order) {
    if (over <= 0) break;
    const d = Math.min(over, s.hold[g]);
    s.basis[g] = (s.basis[g] || 0) * (1 - d / s.hold[g]);
    s.hold[g] -= d; over -= d;
    if (s.hold[g] <= 0) { delete s.hold[g]; delete s.basis[g]; }
  }
  note(s, 'Трюм стал меньше: за борт ушло ' + dropped + ' ящ.');
  return dropped;
}

// ---------- полёт ----------
// Рейс состоит из двух частей. Сначала цеппель идёт по планете отправления к точке перехода:
// это время, топливо, пираты и грозы. Потом переход через Пустоту: он мгновенный, и цеппель
// сразу оказывается в порту назначения. Здесь могут встретиться Знаки Пустоты.
// Длина планетного этапа и опасность порта придуманы для прототипа.
const LEG = {
  zagrata: { days: 2, fuel: 2 },
  tarnok:  { days: 1, fuel: 1 },
  ahadir:  { days: 3, fuel: 3 },
  velmar:  { days: 1, fuel: 1 },
  eltram:  { days: 2, fuel: 2 },
  seryi:   { days: 3, fuel: 3 },
};

function route(s, destId) {
  const a = PLANET[s.planet], b = PLANET[destId];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const st = stats(s);
  const leg = LEG[s.planet];
  return {
    dist,
    fuel: Math.max(1, Math.ceil((leg.fuel + dist / 55) * st.fuelMul)),
    days: leg.days,
  };
}

function maxRange(s) { // дальность перехода в единицах карты на остатке топлива после планетного этапа
  const st = stats(s);
  return Math.max(0, (s.fuel / st.fuelMul - LEG[s.planet].fuel) * 55);
}

const CALM_LINES = [
  'Ровный попутный ветер. Котёл тянет без жалоб.',
  'Облачная гряда осталась внизу. Спокойный перегон.',
  'Ночью за бортом видны огни чужих дирижаблей. Никто не окликнул.',
  'Давление в котле держится. Экипаж играет в кости.',
];

// Опасность порта отправления: пираты нападают на планетном этапе, а не в Пустоте.
// Фронтир и воюющая Заграта хуже, университетские и паломнические трассы патрулируются.
const DANGER = { zagrata: 0.07, tarnok: 0.0, ahadir: -0.04, velmar: -0.03, eltram: -0.05, seryi: 0.12 };

function cargoValue(s) {
  let v = 0;
  for (const [g, n] of Object.entries(s.hold)) v += n * GOOD[g].base;
  return v;
}

// Вероятность встретить пиратов в рейсе.
// Зависит от порта, из которого вылетаем, и от стоимости груза.
function pirateRaw(s) {
  return clamp(0.20 + (DANGER[s.planet] || 0) + Math.min(0.18, cargoValue(s) / 22000), 0.08, 0.6);
}
// Что игрок видит на карте: шанс столкнуться с пиратами.
function pirateRisk(s) {
  return pirateRaw(s);
}

function signChance(s) {
  return clamp(SIGN_BASE * stats(s).signMul, 0, 0.5);
}

function rollEvent(s) {
  const st = stats(s);
  const r = rnd(s);
  const pPir = pirateRaw(s);
  if (r < pPir) {
    const strength = 2 + Math.floor(rnd(s) * 3) + Math.min(5, Math.floor(s.stats.trips / 9));
    return { type: 'pirates', strength };
  }
  if (r < pPir + 0.15) {
    return { type: 'storm' };
  }
  if (r < pPir + 0.15 + 0.05) {
    const good = GOODS[Math.floor(rnd(s) * GOODS.length)].id;
    return { type: 'salvage', good, qty: 2 + Math.floor(rnd(s) * 3) };
  }
  return { type: 'calm', text: CALM_LINES[Math.floor(rnd(s) * CALM_LINES.length)] };
}

function pirateOptions(s, ev) {
  const st = stats(s);
  const tribute = ev.strength * 70 + Math.round(cargoValue(s) * 0.12);
  return {
    tribute,
    canPay: s.cash >= tribute,
    guns: st.guns,
    need: Math.ceil(ev.strength * 1.6),
  };
}

// Шанс выиграть бой в процентах: мощь = пушки*2 + бросок 0..4.
function fightOdds(o) {
  let wins = 0;
  for (let k = 0; k < 5; k++) if (o.guns * 2 + k >= o.need) wins++;
  return wins * 20;
}

// Переход через Пустоту. Мгновенный; иногда проявляется Знак Пустоты.
// 90% знаков зловещие: гибнет или пропадает случайный член экипажа, если он не ямауда.
// Остальные благие: небольшая удача.
function jump(s) {
  if (rnd(s) >= signChance(s)) return null;
  s.stats.signs++;
  if (rnd(s) < SIGN_BAD) {
    if (!s.owned.length) {
      note(s, 'Знак Пустоты прошёл мимо: на борту некому ответить.');
      return { bad: true, none: true, text: 'Знак Пустоты прошёл мимо пустого корабля.' };
    }
    const id = s.owned[Math.floor(rnd(s) * s.owned.length)];
    const c = CARD[id];
    if (c.yamauda) {
      note(s, 'Знак Пустоты коснулся ' + c.name + ', но ямауда невосприимчив к Пустоте.');
      return { bad: true, immune: true, who: c.name, role: ROLES[c.role], text: 'Знак Пустоты коснулся ' + c.name + ' (' + ROLES[c.role] + '), но ямауда невосприимчив к Пустоте.' };
    }
    s.owned = s.owned.filter(x => x !== id);
    for (const r of ROLE_ORDER) if (s.crew[r] === id) s.crew[r] = null;
    s.stats.voidLost++;
    const st = stats(s);
    s.hull = Math.min(s.hull, st.hullMax);
    const dropped = trimCargo(s);
    note(s, 'Знак Пустоты: ' + c.name + ' (' + ROLES[c.role] + ') потерян в переходе.');
    return { bad: true, lost: true, who: c.name, role: ROLES[c.role], dropped, text: 'Зловещий Знак Пустоты. ' + c.name + ' (' + ROLES[c.role] + ') потерян в переходе.' + (dropped ? ' Трюм стал меньше, ' + dropped + ' ящ. ушло за борт.' : '') };
  }
  const st = stats(s);
  const roll = rnd(s);
  let text;
  if (roll < 0.34) { s.hull = st.hullMax; text = 'Благой Знак Пустоты: корпус цел и невредим.'; }
  else if (roll < 0.67) { s.fuel = Math.min(st.tank, s.fuel + 6); text = 'Благой Знак Пустоты: баки пополнились на 6.'; }
  else { const gain = 150 + Math.floor(rnd(s) * 250); s.cash += gain; text = 'Благой Знак Пустоты: в трюме нашлась шкатулка, +' + gain + '.'; }
  note(s, text);
  return { bad: false, text };
}

function applyDamage(s, dmg) {
  s.hull -= dmg;
  if (s.hull <= 0) {
    const st = stats(s);
    s.stats.wrecks++;
    s.hold = {};
    s.basis = {};
    s.cash = Math.floor(s.cash * 0.65);
    s.hull = Math.ceil(st.hullMax * 0.25);
    if (s.flight) s.flight.aborted = true; // до перехода не дошли
    note(s, 'Цеппелин разбит на планетном этапе. Буксир вернул его в порт отправления; груз потерян, ремонт и буксир стоили трети казны.');
    return true;
  }
  return false;
}

function applyEvent(s, ev, choice) {
  const st = stats(s);
  switch (ev.type) {
    case 'evaded':
    case 'calm':
      return note(s, ev.text);
    case 'storm': {
      const dmg = Math.max(1, Math.round((5 + rnd(s) * 8) * st.dmgMul));
      ev.text = note(s, 'Гроза. Корпус потерял ' + dmg + '.');
      if (applyDamage(s, dmg)) ev.text += ' Цеппелин разбит: груз потерян, буксир вернул его в порт отправления.';
      return;
    }
    case 'salvage': {
      const free = st.hold - cargoCount(s);
      if (free > 0) {
        const n = Math.min(ev.qty, free);
        s.hold[ev.good] = (s.hold[ev.good] || 0) + n;
        s.basis[ev.good] = s.basis[ev.good] || 0;
        ev.text = note(s, 'Дрейфующий остов. Подняли на борт: ' + GOOD[ev.good].name + ' ×' + n + '.');
      } else {
        const gain = 60 + Math.floor(rnd(s) * 140);
        s.cash += gain;
        ev.text = note(s, 'Дрейфующий остов. Трюм полон, забрали только ценное: +' + gain + '.');
      }
      return;
    }
    case 'pirates': {
      const o = pirateOptions(s, ev);
      s.stats.pirates++;
      if (choice === 'pay' && o.canPay) {
        s.cash -= o.tribute;
        ev.text = note(s, 'Откупились от пиратов: −' + o.tribute + '.');
        return;
      }
      const power = o.guns * 2 + Math.floor(rnd(s) * 5);
      if (power >= o.need) {
        const loot = ev.strength * 35;
        const dmg = Math.round((1 + ev.strength * rnd(s) * 1.2) * st.dmgMul);
        s.cash += loot;
        ev.text = note(s, 'Бой выигран: трофеи +' + loot + (dmg ? ', корпус −' + dmg : '') + '.');
        if (dmg && applyDamage(s, dmg)) ev.text += ' Цеппелин разбит: груз потерян, буксир вернул его в порт отправления.';
      } else {
        const dmg = Math.max(1, Math.round((ev.strength * 3.5 + rnd(s) * 5) * st.dmgMul));
        const tax = Math.floor(s.cash * 0.1);
        s.cash -= tax;
        let lost = 0;
        for (const g of Object.keys(s.hold)) {
          const l = Math.floor(s.hold[g] * 0.45);
          if (l > 0) {
            s.basis[g] = (s.basis[g] || 0) * (1 - l / s.hold[g]);
            s.hold[g] -= l; lost += l;
          }
        }
        ev.text = note(s, 'Бой проигран: корпус −' + dmg + (lost ? ', пираты забрали ' + lost + ' ящ.' : '') + (tax ? ' и ' + tax + ' из казны' : '') + '.');
        if (applyDamage(s, dmg)) ev.text += ' Цеппелин разбит: груз потерян, буксир вернул его в порт отправления.';
      }
      return;
    }
  }
}

function arrive(s) {
  const f = s.flight;
  s.day += f.days;
  if (f.aborted) {
    note(s, 'Возвращение в порт отправления: ' + PLANET[s.planet].name + '.');
  } else {
    s.planet = f.dest;
    s.stats.trips++;
    note(s, 'Прибытие: ' + PLANET[s.planet].name + '.');
  }
  s.flight = null;
}

// Завершает рейс: если цеппелин дошёл до точки перехода, выполняется переход.
function finishFlight(s, result) {
  if (!s.flight.aborted) {
    const sign = jump(s);
    if (sign) result.sign = sign;
  }
  arrive(s);
  return result;
}

// Вылет. Списывает топливо и жалованье, запускает таймер (eta) и возвращает {ok, flying}.
// Что случилось по дороге, решается в completeFlight, когда таймер истёк.
// opts.now: время вылета в мс (по умолчанию сейчас); opts.instant: без паузы (для ботов и тестов).
function depart(s, destId, opts) {
  opts = opts || {};
  if (s.over) return { ok: false, msg: 'Игра окончена.' };
  if (destId === s.planet) return { ok: false, msg: 'Вы уже здесь.' };
  if (s.flight) return { ok: false, msg: 'Полёт уже идёт.' };
  const r = route(s, destId);
  if (s.fuel < r.fuel) return { ok: false, msg: 'Не хватает топлива: нужно ' + r.fuel + ', есть ' + s.fuel + '.' };
  const st = stats(s);
  s.fuel -= r.fuel;
  const due = st.wage * r.days;
  const wages = Math.min(s.cash, due);
  s.cash -= wages;
  note(s, 'Вылет из порта ' + PLANET[s.planet].name + ' к переходу в ' + PLANET[destId].name + ': ' + r.fuel + ' топлива, ' + r.days + ' дн. по планете, жалованье −' + wages + '.');
  if (wages < due) { // нечем платить: самый дорогой человек сходит на берег навсегда
    const crew = equipped(s).sort((x, y) => y.wage - x.wage);
    if (crew.length) {
      const c = crew[0];
      s.crew[c.role] = null;
      s.owned = s.owned.filter(id => id !== c.id);
      s.stats.deserted++;
      note(s, 'Жалованья не хватило: ' + c.name + ' (' + ROLES[c.role] + ') ушёл с корабля навсегда.');
      trimCargo(s);
    }
  }
  const now = opts.now != null ? opts.now : Date.now();
  s.flight = { dest: destId, days: r.days, ev: null, aborted: false, t0: now, eta: now + (opts.instant ? 0 : flightMs(r.days)) };
  if (opts.instant) return completeFlight(s);
  return { ok: true, flying: true, eta: s.flight.eta, days: r.days };
}

// Когда таймер полёта истёк: происходит событие планетного этапа, затем переход и прибытие.
// Возвращает {ok, pending?, ev?, sign?}. Если pending — интерфейс спрашивает игрока
// и вызывает resolveFlight(s, choice).
function completeFlight(s) {
  if (!s.flight) return { ok: false, msg: 'Нет полёта.' };
  if (s.flight.ev) return { ok: true, pending: s.flight.ev.type === 'pirates', ev: s.flight.ev }; // уже брошено
  const ev = rollEvent(s);
  s.flight.ev = ev;
  if (ev.type === 'pirates') return { ok: true, pending: true, ev };
  applyEvent(s, ev, null);
  return finishFlight(s, { ok: true, pending: false, ev });
}

function resolveFlight(s, choice) {
  if (!s.flight || !s.flight.ev) return { ok: false, msg: 'Нет полёта.' };
  const ev = s.flight.ev;
  applyEvent(s, ev, choice);
  return finishFlight(s, { ok: true, ev });
}

// Банкротство: игра заканчивается, когда нечем продолжать.
// Груз в расчёте идёт по заниженной цене, потому что продавать придётся с потерями.
function liquidity(s) {
  let v = s.cash;
  for (const [g, n] of Object.entries(s.hold)) v += n * GOOD[g].base * 0.6;
  return v;
}

function checkBankrupt(s) {
  if (s.over) return true;
  if (s.flight) return false;
  const minFuel = Math.min(...PLANETS.filter(p => p.id !== s.planet).map(p => route(s, p.id).fuel));
  const topUp = Math.max(0, minFuel - s.fuel) * FUEL_PRICE;
  const liq = liquidity(s);
  if (liq < BANKRUPT_FLOOR || (s.fuel < minFuel && liq < topUp + BANKRUPT_FLOOR / 2)) {
    s.over = { day: s.day, worth: netWorth(s), peak: s.stats.peak || 0 };
    note(s, 'Банкротство. Кредиторы описали цеппелин на причале ' + PLANET[s.planet].name + '.');
    return true;
  }
  return false;
}

function trackPeak(s) {
  const w = netWorth(s);
  if (w > (s.stats.peak || 0)) s.stats.peak = w;
}

// ---------- сохранение ----------
function serialize(s) { return JSON.stringify(s); }
function deserialize(txt) {
  try {
    const s = JSON.parse(txt);
    if (!s || s.v !== 1 || !PLANET[s.planet]) return null;
    s.hold = s.hold || {}; s.basis = s.basis || {};
    s.log = Array.isArray(s.log) ? s.log : [];
    return s;
  } catch (e) { return null; }
}

function describeEff(eff) {
  const out = [];
  if (eff.fuel) out.push((eff.fuel < 0 ? '−' : '+') + Math.round(Math.abs(eff.fuel) * 100) + '% топлива');
  if (eff.sign) out.push('знаки Пустоты −' + Math.round(Math.abs(eff.sign) * 100) + '%');
  if (eff.hull) out.push('корпус +' + eff.hull);
  if (eff.dmg) out.push('урон −' + Math.round(Math.abs(eff.dmg) * 100) + '%');
  if (eff.guns) out.push('пушки +' + eff.guns);
  if (eff.hold) out.push('трюм +' + eff.hold);
  if (eff.buy) out.push('покупка −' + Math.round(Math.abs(eff.buy) * 100) + '%');
  if (eff.sell) out.push('продажа +' + Math.round(eff.sell * 100) + '%');
  return out.join(' · ');
}

if (typeof module !== 'undefined') {
  module.exports = {
    GOODS, GOOD, PLANETS, PLANET, CARDS, CARD, ROLES, ROLE_ORDER, UPGRADES, MAX_UPG,
    FUEL_PRICE, REPAIR_PRICE, PRESSURE_STEP,
    newGame, stats, cargoCount, netWorth, PressureStore, pkey, quote, buy, sell, refuel, repair,
    upgrade, upgradeCost, tavernList, hire, equip, route, maxRange, depart, resolveFlight,
    pirateOptions, completeFlight, setFlightPace, flightMs, fightOdds, pirateRisk, pirateRaw, signChance, jump, trimCargo, LEG, DANGER, SIGN_BASE, cargoValue, checkBankrupt, trackPeak, liquidity, START_CASH, serialize, deserialize, describeEff, rnd,
  };
}
