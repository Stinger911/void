const C = require('./core.js');
function fresh() { const s = C.newGame('t'); s.cash = 50000; s.fuel = 30; return s; }
// 1. частота и последствия знаков
{
  let signs = 0, lost = 0, immune = 0, good = 0, N = 20000;
  for (let i = 0; i < N; i++) {
    const s = fresh(); s.seed = (i * 7919 + 13) | 1;
    const r = C.jump(s);
    if (r) { signs++; if (r.lost) lost++; else if (r.immune) immune++; else if (!r.bad) good++; }
  }
  console.log('шанс знака', (signs / N * 100).toFixed(1) + '% (ожидается', (C.SIGN_BASE * 0.85 * 100).toFixed(1) + '%)',
    '| зловещих среди знаков', ((lost + immune) / signs * 100).toFixed(0) + '%',
    '| из них защитил ямауда', (immune / (lost + immune) * 100).toFixed(0) + '% (в команде 0 ямауда из 4)');
}
// 2. команда целиком из ямауда: потерь нет
{
  const s = fresh();
  s.owned = ['eng2', 'eng3', 'qm2', 'qm3'];
  s.crew = { ast: null, eng: 'eng3', gun: null, qm: 'qm3' };
  let lost = 0, immune = 0;
  for (let i = 0; i < 5000; i++) { s.seed = (i * 104729 + 7) | 1; const r = C.jump(s); if (r && r.lost) lost++; if (r && r.immune) immune++; }
  console.log('команда из ямауда: потерь', lost, ', отражённых знаков', immune, '| владеем', s.owned.length, 'из 4');
}
// 3. астролога из ямауда быть не может
console.log('ямауда-астрологи:', C.CARDS.filter(c => c.role === 'ast' && c.yamauda).length, '| ямауда в других ролях:', C.CARDS.filter(c => c.yamauda).map(c => c.name + ' (' + C.ROLES[c.role] + ')').join(', '));
// 4. астролог снижает шанс знаков
{
  const s = fresh(); const base = C.signChance(s);
  s.owned.push('ast3'); s.crew.ast = 'ast3';
  console.log('шанс знака: базовый астролог', (base * 100).toFixed(1) + '% → Мирра Каст', (C.signChance(s) * 100).toFixed(1) + '%');
}
// 5. пираты зависят от порта вылета, а не назначения
{
  const s = fresh(); const out = {};
  for (const p of C.PLANETS) { s.planet = p.id; out[p.id] = (C.pirateRisk(s) * 100).toFixed(0) + '%'; }
  console.log('риск пиратов по порту вылета (пустой трюм):', JSON.stringify(out));
  s.planet = 'zagrata'; const a = C.pirateRisk(s);
  console.log('от пункта назначения не зависит:', C.PLANETS.filter(p => p.id !== 'zagrata').every(p => C.pirateRisk(s) === a));
}
// 6. рейс занимает время только на планетном этапе
{
  const s = fresh(); const d0 = s.day;
  const r = C.depart(s, 'seryi', { instant: true }); if (r.pending) C.resolveFlight(s, 'fight');
  console.log('Заграта → Серый Предел: дней прошло', s.day - d0, '(этап по Заграте:', C.LEG.zagrata.days + ')', '| порт', s.planet);
}
// 7. крушение на планетном этапе возвращает в порт вылета
{
  let hit = 0, stayed = 0, tripsOk = 0, N = 3000;
  for (let i = 0; i < N; i++) {
    const s = fresh(); s.seed = (i * 6151 + 5) | 1; s.hull = 1; s.upg.gun = 0; s.crew.gun = null; s.owned = s.owned.filter(x => x !== 'gun1');
    s.hold = { relic: 12 }; s.basis = { relic: 3000 };
    const r = C.depart(s, 'eltram', { instant: true }); if (r.pending) C.resolveFlight(s, 'fight');
    if (s.stats.wrecks > 0) { hit++; if (s.planet === 'zagrata') stayed++; if (s.stats.trips === 0) tripsOk++; }
  }
  console.log('крушений в тесте', hit, '| остались в порту вылета', stayed, '| рейс не засчитан', tripsOk);
}
// 8. потеря квартирмейстера сжимает трюм
{
  const s = fresh(); s.owned.push('qm3'); s.crew.qm = 'qm3';
  s.hold = { coal: 25 }; s.basis = { coal: 400 };
  console.log('трюм с Бароном Силем:', C.stats(s).hold, 'груз', C.cargoCount(s));
  s.owned = s.owned.filter(x => x !== 'qm3'); s.crew.qm = null; C.trimCargo(s);
  console.log('после потери: трюм', C.stats(s).hold, 'груз', C.cargoCount(s));
}
