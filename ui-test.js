const {JSDOM}=require('jsdom'); const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const docs={}; const subs=[];
function mkDoc(path){return {id:path.split('/').pop(),path,async set(d){docs[path]=JSON.parse(JSON.stringify(d)); notify();}, async get(){return {exists:!!docs[path],data:()=>docs[path]}}}}
function snapFor(prefix){return {docs:Object.keys(docs).filter(k=>k.startsWith(prefix+'/')).map(k=>({id:k.split('/').pop(),exists:true,data:()=>docs[k]}))}}
function notify(){subs.forEach(s=>s.cb(snapFor(s.prefix)))}
const db={doc:mkDoc,collection(p){const q={orderBy(){return q},limit(){return q},onSnapshot(cb){subs.push({prefix:p,cb});setTimeout(()=>cb(snapFor(p)),0);return()=>{}}};return q}};
const user={async id(){return 'u_test'},async can(){return true}};
function boot(preset){
  const errs=[];
  const dom=new JSDOM('<!doctype html><html><head><style>[hidden]{display:none!important}</style></head><body>'+html+'</body></html>',{url:'https://example.org/',runScripts:'dangerously',pretendToBeVisual:true,
    beforeParse(w){ w.claude={use:async n=>n==='db'?db:n==='user'?user:null}; if(preset) w.localStorage.setItem('paroviy-torg-v4',preset); w.addEventListener('error',e=>errs.push(e.message)); }});
  return {w:dom.window,d:dom.window.document,errs};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const {w,d,errs}=boot();
  const click=sel=>{const el=d.querySelector(sel); if(!el) throw new Error('no '+sel); el.click();};
  const until=async(fn,ms=4000)=>{const t=Date.now(); while(Date.now()-t<ms){ if(fn()) return true; await sleep(20);} return false;};
  await sleep(100);
  console.log('net:',d.querySelector('#net').textContent, '| market rows', d.querySelectorAll('.row').length);
  // торговля со слайдером
  click('[data-act="trade"][data-m="buy"][data-g="coal"]');
  const sl=d.querySelector('#tqty'); sl.value='7'; sl.dispatchEvent(new w.Event('input',{bubbles:true}));
  console.log('слайдер:',d.querySelector('#tn').textContent,'|',d.querySelector('#tok').textContent);
  click('[data-act="trade-ok"]');
  // пауза на перелёт: реальные 15 с на день
  console.log('темп по умолчанию, мс на день:', w.eval('FLIGHT_MS_PER_DAY'));
  click('[data-tab="map"]'); click('.dest[data-p="tarnok"]');
  console.log('кнопка:', d.querySelector('[data-act="go"]').textContent);
  w.eval('setFlightPace(400)');
  const day0=w.eval('S.day'), t0=Date.now();
  click('[data-act="go"]');
  console.log('сразу после вылета: окно полёта', !!d.querySelector('.flightbox'), '| S.flight', !!w.eval('S.flight'), '| день', w.eval('S.day'),'(был',day0+') | порт', w.eval('S.planet'));
  await sleep(150);
  console.log('через 150 мс всё ещё в пути:', !!w.eval('S.flight'), '| таймер:', d.querySelector('#fl-left').textContent, '| полоса', d.querySelector('#fl-bar').style.width);
  // перезагрузка страницы посреди рейса должна продолжить отсчёт
  const saved=w.localStorage.getItem('paroviy-torg-v4');
  const re=boot(saved); await sleep(60);
  console.log('после перезагрузки рейс продолжается:', !!re.d.querySelector('.flightbox'), '| S.flight', !!re.w.eval('S.flight'));
  await until(()=>!w.eval('S.flight') || d.querySelector('[data-act="pirate"]'));
  const p1=d.querySelector('[data-act="pirate"][data-c="fight"]'); if(p1) p1.click();
  await until(()=>!w.eval('S.flight'));
  console.log('прилетели через', Date.now()-t0, 'мс | порт', w.eval('S.planet'), '| день', w.eval('S.day'), '| окно закрыто', !d.querySelector('.flightbox') || !d.querySelector('.flightbox').isConnected);
  const sg=d.querySelector('[data-act="ack"]'); if(sg) sg.click();
  // рейс, у которого срок давно прошёл: при загрузке садимся сразу
  const s2=JSON.parse(w.localStorage.getItem('paroviy-torg-v4'));
  s2.flight={dest:'eltram',days:2,ev:null,aborted:false,t0:Date.now()-60000,eta:Date.now()-30000}; s2.planet='tarnok'; s2.day=10;
  const re2=boot(JSON.stringify(s2)); await sleep(80);
  const pr=re2.d.querySelector('[data-act="pirate"][data-c="fight"]'); if(pr) pr.click();
  console.log('просроченный рейс при загрузке: S.flight', !!re2.w.eval('S.flight'), '| порт', re2.w.eval('S.planet'), '| день', re2.w.eval('S.day'), '| ошибок', re2.errs.length);
  // серия рейсов
  for(let i=0;i<14;i++){
    click('[data-tab="market"]');
    d.querySelectorAll('[data-act="trade"][data-m="sell"]').forEach(b=>{ if(!b.disabled){ b.click(); const ok=d.querySelector('[data-act="trade-ok"]'); if(ok) ok.click(); } });
    const r=d.querySelector('[data-act="refuel"]'); if(r&&!r.disabled) r.click();
    const rp=d.querySelector('[data-act="repair"]'); if(rp&&!rp.disabled) rp.click();
    if(d.querySelector('#ot')){ click('[data-act="restart"]'); }
    w.eval('setFlightPace(25)');
    click('[data-tab="map"]');
    const dests=[...d.querySelectorAll('.dest:not(.far)')]; if(!dests.length) continue;
    dests[i%dests.length].click();
    const go=d.querySelector('[data-act="go"]'); if(!go||go.disabled) continue; go.click();
    await until(()=>!w.eval('S.flight') || d.querySelector('[data-act="pirate"]'));
    const pb=d.querySelector('[data-act="pirate"][data-c="fight"]'); if(pb) pb.click();
    await until(()=>!w.eval('S.flight'));
    const a=d.querySelector('[data-act="ack"]'); if(a) a.click();
  }
  console.log('после серии: рейсов', w.eval('S.stats.trips'), '| сводка события:', !!d.querySelector('.bulletin'), '| ошибок', errs.length);
  // банкротство
  w.eval("S.flight=null; S.cash = 10; S.hold = {}; S.basis = {}; after({ ok: true })");
  console.log('банкротство:', d.querySelector('#ot') && d.querySelector('#ot').textContent);
  click('[data-act="restart"]'); console.log('новая игра: казна', w.eval('S.cash'));
  console.log('errors:',errs);
  process.exit(0);
})();
