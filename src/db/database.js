const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/promobot.db');
let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ml_id TEXT UNIQUE,
      title TEXT NOT NULL,
      original_price REAL,
      sale_price REAL NOT NULL,
      discount_percent INTEGER,
      image_url TEXT,
      original_url TEXT NOT NULL,
      affiliate_url TEXT NOT NULL,
      category TEXT,
      seller TEXT,
      source TEXT DEFAULT 'mercadolivre',
      found_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      posted_at DATETIME,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category_filter TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promotion_id INTEGER REFERENCES promotions(id),
      channel_id INTEGER REFERENCES channels(id),
      telegram_message_id TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      clicks INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}',
      last_run DATETIME,
      last_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_promotions_ml_id ON promotions(ml_id);
    CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions(status);
    CREATE INDEX IF NOT EXISTS idx_promotions_found_at ON promotions(found_at);
  `);

  // Insere fontes padrão se não existirem
  const defaults = [
    { id: 'ml_offers',   name: 'Mercado Livre — Ofertas do dia',   active: 1, config: '{}' },
    { id: 'ml_keyword',  name: 'Mercado Livre — Palavras-chave',   active: 1, config: '{}' },
    { id: 'ml_category', name: 'Mercado Livre — Categorias',       active: 1, config: '{}' },
    { id: 'shopee',      name: 'Shopee — Ofertas do dia',          active: 0, config: '{}' },
    { id: 'shopee_kw',   name: 'Shopee — Palavras-chave',          active: 0, config: '{}' },
    { id: 'pelando_hot',  name: 'Hardmob — Promoções (RSS)',          active: 1, config: '{}' },
    { id: 'pelando_recent', name: 'Hardmob — Recentes (desativado)', active: 0, config: '{}' },
    { id: 'rakuten',      name: 'Rakuten — Coupon Feed (BR)',        active: 0, config: '{}' },
  ];
  const stmt = db.prepare(`INSERT OR IGNORE INTO sources (id, name, active, config) VALUES (@id, @name, @active, @config)`);
  defaults.forEach(s => stmt.run(s));
}

// Promoções
function savePromotion(promo) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO promotions 
      (ml_id, title, original_price, sale_price, discount_percent, image_url, original_url, affiliate_url, category, seller, source)
    VALUES 
      (@ml_id, @title, @original_price, @sale_price, @discount_percent, @image_url, @original_url, @affiliate_url, @category, @seller, @source)
  `);
  return stmt.run({ source: 'mercadolivre', ...promo }).changes > 0;
}

function getPendingPromotions() {
  return getDb().prepare(`
    SELECT * FROM promotions WHERE status = 'pending'
    ORDER BY discount_percent DESC, found_at DESC LIMIT 20
  `).all();
}

function markAsPosted(id) {
  getDb().prepare(`UPDATE promotions SET status='posted', posted_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
}

function markAsIgnored(id) {
  getDb().prepare(`UPDATE promotions SET status='ignored' WHERE id=?`).run(id);
}

function getHistory(limit = 50, offset = 0) {
  return getDb().prepare(`
    SELECT p.*, COUNT(DISTINCT po.id) as post_count, GROUP_CONCAT(DISTINCT c.name) as channel_names
    FROM promotions p
    LEFT JOIN posts po ON p.id = po.promotion_id
    LEFT JOIN channels c ON po.channel_id = c.id
    WHERE p.status IN ('posted','pending','ignored')
    GROUP BY p.id ORDER BY p.found_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function getStats() {
  const db = getDb();
  return {
    today:       db.prepare(`SELECT COUNT(*) as n FROM promotions WHERE date(found_at)=date('now')`).get().n,
    posted:      db.prepare(`SELECT COUNT(*) as n FROM promotions WHERE status='posted'`).get().n,
    pending:     db.prepare(`SELECT COUNT(*) as n FROM promotions WHERE status='pending'`).get().n,
    total:       db.prepare(`SELECT COUNT(*) as n FROM promotions`).get().n,
    avgDiscount: Math.round(db.prepare(`SELECT AVG(discount_percent) as n FROM promotions WHERE discount_percent IS NOT NULL`).get().n || 0),
  };
}

// Canais
function getChannels() {
  return getDb().prepare(`SELECT * FROM channels ORDER BY active DESC, name`).all();
}
function saveChannel(ch) {
  getDb().prepare(`INSERT OR REPLACE INTO channels (telegram_id,name,category_filter,active) VALUES (@telegram_id,@name,@category_filter,@active)`).run(ch);
}
function toggleChannel(id) {
  getDb().prepare(`UPDATE channels SET active=CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?`).run(id);
}

// Posts
function savePost(post) {
  getDb().prepare(`INSERT INTO posts (promotion_id,channel_id,telegram_message_id) VALUES (@promotion_id,@channel_id,@telegram_message_id)`).run(post);
}

// Fontes
function getSources() {
  return getDb().prepare(`SELECT * FROM sources ORDER BY id`).all();
}
function toggleSource(id) {
  getDb().prepare(`UPDATE sources SET active=CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?`).run(id);
}
function updateSourceRun(id, count) {
  getDb().prepare(`UPDATE sources SET last_run=CURRENT_TIMESTAMP, last_count=? WHERE id=?`).run(count, id);
}
function isSourceActive(id) {
  const row = getDb().prepare(`SELECT active FROM sources WHERE id=?`).get(id);
  return row ? row.active === 1 : false;
}

module.exports = {
  getDb, savePromotion, getPendingPromotions, markAsPosted, markAsIgnored,
  getHistory, getStats, getChannels, saveChannel, toggleChannel, savePost,
  getSources, toggleSource, updateSourceRun, isSourceActive,
};
