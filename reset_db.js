const db = require('better-sqlite3')('data/promobot.db');
const r1 = db.prepare("DELETE FROM posts").run();
const r2 = db.prepare("DELETE FROM promotions").run();
console.log('Banco limpo: ' + r2.changes + ' promoções e ' + r1.changes + ' posts removidos.');
db.close();
