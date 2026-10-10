// Прогоняет кнопку меню через реальное окно приложения (CDP).
const { execFileSync } = require('child_process');
const http = require('http');

function installed() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\Directory\\shell\\PixPort'], { encoding: 'utf8', stdio: 'pipe' });
    return out.includes('PixPort');
  } catch { return false; }
}

function targets() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222/json', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

(async () => {
  const ok = [], bad = [];
  const check = (n, c, x = '') => (c ? ok : bad).push(n + (x ? ' → ' + x : ''));

  const list = await targets();
  const page = list.find(t => t.type === 'page');
  if (!page) { console.log('нет страницы'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable');

  // 1. начальное состояние
  const before = await evalJs(`document.getElementById('mb')?.textContent || document.getElementById('menuBtn')?.textContent || 'НЕТ КНОПКИ'`);
  check('кнопка найдена', before !== 'НЕТ КНОПКИ', before);
  check('текст соответствует реестру', (before.includes('Убрать') === installed()), `кнопка="${before}" реестр=${installed()}`);

  // 2. нажимаем
  await evalJs(`(document.getElementById('mb') || document.getElementById('menuBtn')).click()`);
  await new Promise(r => setTimeout(r, 2500)); // даём времени на reg.exe

  const after = await evalJs(`document.getElementById('mb')?.textContent || document.getElementById('menuBtn')?.textContent`);
  check('реестр переключился', after.includes('Убрать') === installed(), `кнопка="${after}" реестр=${installed()}`);
  check('текст сменился', after !== before, `"${before}" → "${after}"`);

  // 3. жмём ещё раз — должно вернуться
  await evalJs(`(document.getElementById('mb') || document.getElementById('menuBtn')).click()`);
  await new Promise(r => setTimeout(r, 2500));
  const back = await evalJs(`document.getElementById('mb')?.textContent || document.getElementById('menuBtn')?.textContent`);
  check('повторное нажатие вернуло', back.includes('Убрать') === installed() && back === before, `"${back}" реестр=${installed()}`);

  console.log('ПРОЙДЕНО:'); ok.forEach(o => console.log('  ✓ ' + o));
  if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  ✗ ' + b)); }
  console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
  ws.close();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
