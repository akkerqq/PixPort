// Генератор ключей PixPort Pro. Запуск: node genkey.js [сколько]
// В сборку не попадает (build.js → ignore).
const { mintKey } = require('./license');

const n = Math.max(1, parseInt(process.argv[2], 10) || 1);
for (let i = 0; i < n; i++) console.log(mintKey());
