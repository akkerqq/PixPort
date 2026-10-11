/**
 * PixPort — автозапуск Windows (галочка в настройках).
 * Пишем напрямую в HKCU\...\Run /v PixPort через reg.exe.
 *
 * Почему не app.setLoginItemSettings: в Electron 44 он молча ничего
 * не делает — возвращает успех, а в реестре пусто (проверено 11.10.2026:
 * и с path/args, и голый вызов; get при этом врал true). Только reg.exe.
 */
const { execFileSync } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'PixPort';

/**
 * Команда для реестра.
 * packed: "C:\...\PixPort.exe"
 * dev:    "C:\...\electron.exe" "C:\...\pixport"
 */
function commandFor({ exe, appDir }) {
  return appDir ? `"${exe}" "${appDir}"` : `"${exe}"`;
}

/** Автозапуск включён? */
function isEnabled() {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', NAME], { encoding: 'utf8', stdio: 'pipe' });
    return out.includes(NAME);
  } catch (e) {
    return false;
  }
}

/** Включить/выключить. Возвращает { ok } по факту сверки с реестром. */
function setEnabled(on, opts) {
  if (on) {
    execFileSync('reg', ['add', RUN_KEY, '/v', NAME, '/t', 'REG_SZ', '/d', commandFor(opts), '/f'],
      { encoding: 'utf8', stdio: 'pipe' });
  } else {
    try {
      execFileSync('reg', ['delete', RUN_KEY, '/v', NAME, '/f'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) { /* уже нет — и ладно */ }
  }
  return { ok: isEnabled() === !!on };
}

module.exports = { isEnabled, setEnabled, commandFor, RUN_KEY, NAME };
