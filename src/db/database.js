const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') 
    ? { rejectUnauthorized: false } 
    : false
});

async function getDb() {
  return pool;
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY,
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
      extra_info TEXT,
      found_at TIMESTAMP DEFAULT NOW(),
      posted_at TIMESTAMP,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category_filter TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      promotion_id INTEGER REFERENCES promotions(id),
      channel_id INTEGER REFERENCES channels(id),
      telegram_message_id TEXT,
      sent_at TIMESTAMP DEFAULT NOW(),
      clicks INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}',
      last_run TIMESTAMP,
      last_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_promotions_ml_id ON promotions(ml_id);
    CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions(status);
    CREATE INDEX IF NOT EXISTS idx_promotions_found_at ON promotions(found_at);
  `);

  // Migração segura: adiciona coluna se não existir
  await pool.query(`
    ALTER TABLE promotions ADD COLUMN IF NOT EXISTS extra_info TEXT;
  `);

  // Insere fontes padrão
  await pool.query(`
    INSERT INTO sources (id, name, active, config) VALUES
      ('shopee',     'Shopee — Ofertas do dia',    1, '{}'),
      ('shopee_kw',  'Shopee — Palavras-chave',    1, '{}'),
      ('rakuten',    'Rakuten — Coupon Feed (BR)', 1, '{}')
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function savePromotion(promo) {
  const sanitized = {
    ml_id:            promo.ml_id,
    title:            (promo.title || 'Produto').substring(0, 255),
    original_price:   parseFloat(promo.original_price) || null,
    sale_price:       parseFloat(promo.sale_price) || 0,
    discount_percent: parseInt(promo.discount_percent) || 0,
    image_url:        promo.image_url || null,
    original_url:     promo.original_url || promo.affiliate_url || '#',
    affiliate_url:    promo.affiliate_url || '#',
    category:         promo.category || null,
    seller:           promo.seller || null,
    source:           promo.source || 'mercadolivre',
  };

  const result = await pool.query(`
    INSERT INTO promotions 
      (ml_id, title, original_price, sale_price, discount_percent, image_url, original_url, affiliate_url, category, seller, source)
    VALUES 
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (ml_id) DO NOTHING
  `, Object.values(sanitized));

  return result.rowCount > 0;
}

async function getPendingPromotions() {
  const { rows } = await pool.query(`
    SELECT * FROM promotions WHERE status = 'pending'
    ORDER BY discount_percent DESC, found_at DESC LIMIT 20
  `);
  return rows;
}

async function markAsPosted(id) {
  await pool.query(`UPDATE promotions SET status='posted', posted_at=NOW() WHERE id=$1`, [id]);
}

async function markAsIgnored(id) {
  await pool.query(`UPDATE promotions SET status='ignored' WHERE id=$1`, [id]);
}

async function getHistory(limit = 50, offset = 0) {
  const { rows } = await pool.query(`
    SELECT p.*, COUNT(DISTINCT po.id) as post_count, STRING_AGG(DISTINCT c.name, ',') as channel_names
    FROM promotions p
    LEFT JOIN posts po ON p.id = po.promotion_id
    LEFT JOIN channels c ON po.channel_id = c.id
    WHERE p.status IN ('posted','pending','ignored')
    GROUP BY p.id ORDER BY p.found_at DESC LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

async function getStats() {
  const [today, posted, pending, total, avg] = await Promise.all([
    pool.query(`SELECT COUNT(*) as n FROM promotions WHERE DATE(found_at)=CURRENT_DATE`),
    pool.query(`SELECT COUNT(*) as n FROM promotions WHERE status='posted'`),
    pool.query(`SELECT COUNT(*) as n FROM promotions WHERE status='pending'`),
    pool.query(`SELECT COUNT(*) as n FROM promotions`),
    pool.query(`SELECT AVG(discount_percent) as n FROM promotions WHERE discount_percent IS NOT NULL`),
  ]);
  return {
    today:       parseInt(today.rows[0].n),
    posted:      parseInt(posted.rows[0].n),
    pending:     parseInt(pending.rows[0].n),
    total:       parseInt(total.rows[0].n),
    avgDiscount: Math.round(parseFloat(avg.rows[0].n) || 0),
  };
}

async function getChannels() {
  const { rows } = await pool.query(`SELECT * FROM channels ORDER BY active DESC, name`);
  return rows;
}

async function saveChannel(ch) {
  await pool.query(`
    INSERT INTO channels (telegram_id, name, category_filter, active)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (telegram_id) DO UPDATE SET name=$2, category_filter=$3, active=$4
  `, [ch.telegram_id, ch.name, ch.category_filter, ch.active]);
}

async function toggleChannel(id) {
  await pool.query(`UPDATE channels SET active=CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=$1`, [id]);
}

async function savePost(post) {
  await pool.query(`
    INSERT INTO posts (promotion_id, channel_id, telegram_message_id)
    VALUES ($1,$2,$3)
  `, [post.promotion_id, post.channel_id, post.telegram_message_id]);
}

async function getSources() {
  const { rows } = await pool.query(`SELECT * FROM sources ORDER BY id`);
  return rows;
}

async function toggleSource(id) {
  await pool.query(`UPDATE sources SET active=CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=$1`, [id]);
}

async function updateSourceRun(id, count) {
  await pool.query(`UPDATE sources SET last_run=NOW(), last_count=$1 WHERE id=$2`, [count, id]);
}

async function isSourceActive(id) {
  const { rows } = await pool.query(`SELECT active FROM sources WHERE id=$1`, [id]);
  return rows[0] ? rows[0].active === 1 : false;
}

// Inicializa o schema ao subir
initSchema().catch(console.error);

module.exports = {
  getDb, savePromotion, getPendingPromotions, markAsPosted, markAsIgnored,
  getHistory, getStats, getChannels, saveChannel, toggleChannel, savePost,
  getSources, toggleSource, updateSourceRun, isSourceActive,
};