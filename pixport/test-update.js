// Проверка обновлений: GitHub подменяем локальным стабом через PIXPORT_UPDATE_URL.
// Кейсы: версия новее → update:true + ссылка на Setup; старее → update:false;
// стаб лёг → ok:false. Секция есть в обоих окнах ПК.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const STUB_PORT = 8799;
const APP_PORT = 8765;
const FOLDER = process.argv[2];

let tag = 'v9.9.9'; // стаб отдаёт его как tag_name свежего релиза
let stubUp = true;

const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/set') { // управление стабом из теста: /set?tag=v1.2.3 / /set?down=1
    if (u.searchParams.get('down') === '1') { stubUp = false; }
    else { stubUp = true; tag = u.searchParams.get('tag') || tag; }
    res.end('ok');
    return;
  }
  if (!stubUp) { res.writeHead(500); res.end('down'); return; }
  if (u.pathname === '/releases/latest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: tag,
      html_url: 'https://github.com/akkerqq/PixPort/releases/tag/' + tag,
      assets: [
        { name: 'PixPort-Setup-9.9.9.exe', browser_download_url: 'https://github.com/akkerqq/PixPort/releases/download/v9.9.9/PixPort-Setup-9.9.9.exe' },
        { name: 'latest.json', browser_download_url: 'https://github.com/x' },
      ],
    }));
    return;
  }
  res.writeHead(404); res.end('no');
});

function get(url) {
  return new Promise((res, rej) => http.get(url, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res({ code: r.statusCode, body: d }));
  }).on('error', rej));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const ok = [], bad = [];
  const check = (n, c, e = '') => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));
  await new Promise(r => stub.listen(STUB_PORT, '127.0.0.1', r));

  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js'), FOLDER], {
    env: { ...process.env, PIXPORT_UPDATE_URL: `http://127.0.0.1:${STUB_PORT}/releases/latest` },
    stdio: 'ignore',
  });
  try {
    // ждём сервер
    for (let i = 0; i < 30; i++) {
      try { const p = await get(`http://127.0.0.1:${APP_PORT}/?folder=${encodeURIComponent(FOLDER)}`); if (p.code === 200) break; } catch (e) {}
      await sleep(500);
    }

    // 1. релиз новее → update:true + ссылка именно на Setup exe
    const page = await get(`http://127.0.0.1:${APP_PORT}/?folder=${encodeURIComponent(FOLDER)}`);
    check('секция обновлений в окне QR', page.body.includes('id="updStatus"') && page.body.includes('updCheck'));
    const u1 = JSON.parse((await get(`http://127.0.0.1:${APP_PORT}/api/update`)).body);
    check('релиз новее → update:true', u1.ok === true && u1.update === true && u1.latest === '9.9.9', JSON.stringify(u1));
    check('ссылка ведёт на Setup exe', (u1.url || '').endsWith('PixPort-Setup-9.9.9.exe'), u1.url);

    // 2. релиз старше → update:false
    await get(`http://127.0.0.1:${STUB_PORT}/set?tag=v0.0.1`);
    const u2 = JSON.parse((await get(`http://127.0.0.1:${APP_PORT}/api/update`)).body);
    check('релиз старше → update:false', u2.ok === true && u2.update === false, JSON.stringify(u2));

    // 3. GitHub лёг → ok:false, а не падение
    await get(`http://127.0.0.1:${STUB_PORT}/set?down=1`);
    const u3 = JSON.parse((await get(`http://127.0.0.1:${APP_PORT}/api/update`)).body);
    check('без сети → ok:false', u3.ok === false, JSON.stringify(u3));

    // 4. секция есть и в окне «Выбери папку»
    await get(`http://127.0.0.1:${STUB_PORT}/set?tag=v9.9.9`);
    const t = (page.body.match(/const token = '([^']+)'/) || [])[1];
    if (t) await get(`http://127.0.0.1:${APP_PORT}/api/close?t=${t}`);
    const pick = await get(`http://127.0.0.1:${APP_PORT}/`);
    check('секция обновлений в окне выбора папки', pick.body.includes('id="updStatus"') && pick.body.includes('id="updDl"'));
  } finally {
    srv.kill();
    stub.close();
  }

  console.log('\nПРОЙДЕНО:'); ok.forEach(o => console.log('  ✓ ' + o));
  if (bad.length) { console.log('ПРОВАЛЕНО:'); bad.forEach(b => console.log('  ✗ ' + b)); }
  console.log(`\nИтог: ${ok.length} ок, ${bad.length} провалено`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('Ошибка теста:', e); process.exit(1); });
