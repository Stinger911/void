const C = require('./core.js');
const RUNS = +process.argv[3] || 200;
const DAYS = 200;
const TRIPS = +process.argv[4] || 80;

function run(policy, seedShift) {
  let fakeNow = 0;
  const store = new C.PressureStore(() => fakeNow);
  const s = C.newGame('bot');
  s.seed = (seedShift * 2654435761) & 0x7fffffff | 1;
  let steps = 0;
  while (s.stats.trips < TRIPS && steps < 900) {
    steps++; fakeNow += 180000;
    C.trackPeak(s);
    if (C.checkBankrupt(s)) break;
    policy(s, store, C);
    if (s.over) break;
  }
  C.trackPeak(s); C.checkBankrupt(s);
  return { over: !!s.over, day: s.day, worth: C.netWorth(s), peak: s.stats.peak, wrecks: s.stats.wrecks, pirates: s.stats.pirates, deserted: s.stats.deserted, trips: s.stats.trips, voidLost: s.stats.voidLost, signs: s.stats.signs };
}

// лучшее плечо из порта from: купить у себя, продать в порту p (цены на момент прибытия)
function bestLeg(s, store, from, day, cash, risk) {
  const st = C.stats(s);
  let best = null;
  for (const p of C.PLANETS) {
    if (p.id === from) continue;
    const r = C.route({ ...s, planet: from }, p.id);
    for (const g of C.GOODS) {
      const sf = { ...s, planet: from, day };
      const q0 = C.quote(sf, store, from, g.id);
      const q1 = C.quote({ ...s, planet: p.id, day: day + r.days }, store, p.id, g.id);
      const per = q1.sell - q0.buy;
      if (per <= 0) continue;
      const n = Math.min(st.hold, Math.floor((cash - r.fuel * C.FUEL_PRICE) / q0.buy));
      if (n <= 0) continue;
      const rk = risk ? C.pirateRaw({ ...s, planet: from, hold: { [g.id]: n } }) : 0;
      const gross = per * n * (1 - rk * 0.45);
      const cost = r.fuel * C.FUEL_PRICE + st.wage * r.days;
      const net = gross - cost;
      if (!best || net / r.days > best.net / best.days) best = { p, g: g.id, n, gross, cost, net, days: r.days, fuel: r.fuel };
    }
  }
  return best;
}

function pickTrade(s, store, careful) {
  const st = C.stats(s);
  const cash = s.cash;
  let best = null;
  for (const p of C.PLANETS) {
    if (p.id === s.planet) continue;
    const r = C.route(s, p.id);
    if (r.fuel > s.fuel + Math.floor(cash / C.FUEL_PRICE)) continue;
    for (const g of C.GOODS) {
      const q0 = C.quote(s, store, s.planet, g.id);
      const q1 = C.quote({ ...s, planet: p.id, day: s.day + r.days }, store, p.id, g.id);
      const per = q1.sell - q0.buy;
      const n = per > 0 ? Math.min(st.hold, Math.floor((cash - r.fuel * C.FUEL_PRICE) / q0.buy)) : 0;
      if (per > 0 && n <= 0) continue;
      const rk = careful ? C.pirateRaw({ ...s, hold: n > 0 ? { [g.id]: n } : {} }) : 0;
      const gross = n > 0 ? per * n * (1 - rk * 0.45) : 0;
      const cost = r.fuel * C.FUEL_PRICE + st.wage * r.days;
      const cash2 = cash + gross - cost;
      const second = careful ? bestLeg(s, store, p.id, s.day + r.days, Math.max(0, cash2), true) : null;
      const net2 = second ? second.net : 0;
      const days2 = second ? second.days : 0;
      const score = (gross - cost + net2) / (r.days + days2);
      if (!best || score > best.score) best = { score, p, g: n > 0 ? g.id : null, n, gross, cost };
    }
  }
  return best;
}

function careful(s, store, C) {
  for (const g of Object.keys(s.hold)) C.sell(s, store, g, 999);
  C.refuel(s, Math.max(0, 8 + 6 - s.fuel + 6));
  { const st = C.stats(s); if (s.hull < st.hullMax * 0.6) C.repair(s, st.hullMax - s.hull); }
  // найм: пустой пост закрываем самым дешёвым подходящим, ямауда в приоритете
  for (const role of C.ROLE_ORDER) {
    if (s.crew[role]) continue;
    const opts = C.tavernList(s).filter(c => c.role === role && s.cash > c.cost + 450).sort((a, b) => (b.yamauda ? 1 : 0) - (a.yamauda ? 1 : 0) || a.cost - b.cost);
    if (opts.length) { C.hire(s, opts[0].id); }
  }
  // апгрейды: сначала пушки, затем корпус, трюм, бак; держим резерв
  const order = ['gun', 'hull', 'hold', 'tank', 'gun'];
  for (const k of order) { if (s.cash > C.upgradeCost(s, k) + 700 && s.upg[k] < 5) { C.upgrade(s, k); break; } }
  const keep = 260; s.cash -= keep;
  const b = pickTrade(s, store, true);
  s.cash += keep;
  if (!b) {
    // без выгодной сделки идём в самый безопасный дешёвый порт
    const cand = C.PLANETS.filter(p => p.id !== s.planet && C.route(s, p.id).fuel <= s.fuel).sort((x, y) => C.route(s, x.id).fuel - C.route(s, y.id).fuel)[0];
    if (!cand) { C.checkBankrupt(s); return; }
    const d = C.depart(s, cand.id, { instant: true }); if (d.pending) resolve(s, C, true); return;
  }
  if (b.g) { s.cash -= keep; C.buy(s, store, b.g, b.n); s.cash += keep; }
  const d = C.depart(s, b.p.id, { instant: true });
  if (d.pending) resolve(s, C, true);
}

function resolve(s, C, smart) {
  const o = C.pirateOptions(s, s.flight.ev);
  let choice = 'fight';
  if (smart) choice = (C.fightOdds(o) < 60 && o.canPay) ? 'pay' : 'fight';
  C.resolveFlight(s, choice);
}

function reckless(s, store, C) {
  for (const g of Object.keys(s.hold)) C.sell(s, store, g, 999);
  C.refuel(s, 999);
  if (s.hull < 12) C.repair(s, 999);
  if (s.cash > C.upgradeCost(s, 'hold') + 300 && s.upg.hold < 5) C.upgrade(s, 'hold');
  const b = pickTrade(s, store, false);
  if (!b) { C.checkBankrupt(s); const cand = C.PLANETS.find(p => p.id !== s.planet && C.route(s, p.id).fuel <= s.fuel); if (!cand) return; const d = C.depart(s, cand.id, { instant: true }); if (d.pending) resolve(s, C, false); return; }
  if (b.g) C.buy(s, store, b.g, b.n);
  const d = C.depart(s, b.p.id, { instant: true });
  if (d.pending) resolve(s, C, false);
}

const which = process.argv[2] || 'both';
function summarize(name, pol) {
  const rs = [];
  for (let i = 1; i <= RUNS; i++) rs.push(run(pol, i));
  const bust = rs.filter(r => r.over);
  const worths = rs.map(r => r.worth).sort((a, b) => a - b);
  const q = f => worths[Math.floor(f * (worths.length - 1))];
  const peaks = rs.map(r => r.peak).sort((a, b) => a - b);
  const avg = k => (rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(1);
  console.log(name.padEnd(9), 'банкротов', Math.round(bust.length / rs.length * 100) + '%',
    '| капитал д.200: p10', q(0.1), 'мед', q(0.5), 'p90', q(0.9),
    '| пик мед', peaks[Math.floor(peaks.length / 2)],
    '| ср. потерь в Пустоте', avg('voidLost'), '| ср. крушений', avg('wrecks'), 'пираты', avg('pirates'), 'дезертиров', avg('deserted'),
    '| ср.день банкрота', bust.length ? Math.round(bust.reduce((a, r) => a + r.day, 0) / bust.length) : '-');
}
if (which === 'both' || which === 'careful') summarize('careful', careful);
if (which === 'both' || which === 'reckless') summarize('reckless', reckless);
