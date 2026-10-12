// Генератор ключей PixPort Pro. Запуск: node genkey.js [сколько] [--bound КОД_МАШИНЫ]
// В сборку не попадает (build.js → ignore).
//  - без флагов: открытые ключи (друзьям, себе);
//  - --bound: именной ключ под код машины покупателя (код присылают в чат
//    вместе с оплатой, сам код виден в Настройках → Подписка).
const { mintKey, mintBoundKey } = require('./license');

const args = process.argv.slice(2);
const bi = args.indexOf('--bound');
let bound = null;
if (bi >= 0) { bound = args[bi + 1] || ''; args.splice(bi, 2); }

const n = Math.max(1, parseInt(args[0], 10) || 1);
for (let i = 0; i < n; i++) console.log(bound !== null ? mintBoundKey(bound) : mintKey());
