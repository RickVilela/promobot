const cron = require('node-cron');
const { scrapeShopeeOffers, scrapeShopeeKeyword } = require('./scraper/shopeeScraper');
const { scrapeRakutenOffers } = require('./scraper/rakutenScraper');
const { savePromotion, getPendingPromotions, markAsPosted, updateSourceRun, isSourceActive } = require('./db/database');
const { sendPromotion: sendTelegram } = require('./bot/telegram');
const { sendPromotion: sendWhatsApp, isConfigured: whatsappConfigured } = require('./bot/whatsapp');

let isRunning = false;
let lastRunAt = null;
let nextRunAt = null;
let cronJob = null;

function getConfig() {
  return {
    mlAffiliateTag:     process.env.ML_AFFILIATE_TAG || 'seutag-55',
    shopeeAffiliateTag: process.env.SHOPEE_AFFILIATE_TAG || '',
    minDiscount:        parseInt(process.env.MIN_DISCOUNT_PERCENT || '15'),
    intervalMinutes:    parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '30'),
    keywords:           (process.env.SEARCH_KEYWORDS || '').split(',').map(k => k.trim()).filter(Boolean),
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendPromotion(promo) {
  const results = {};

  // Telegram
  const tg = await sendTelegram(promo);
  results.telegram = tg;

  // WhatsApp (se configurado)
  if (whatsappConfigured()) {
    await delay(500);
    const wa = await sendWhatsApp(promo);
    results.whatsapp = wa;
  }

  return {
    success: results.telegram?.success || results.whatsapp?.success,
    results,
  };
}

async function runScrapeAndPost() {
  if (isRunning) { console.log('[Scheduler] Já em execução, pulando...'); return { skipped: true }; }

  isRunning = true;
  lastRunAt = new Date();
  console.log('\n[Scheduler] ═══ Iniciando ciclo de scraping ═══');

  const cfg = getConfig();
  const allPromos = [];

  // ── Shopee ──────────────────────────────────────────────
  if (isSourceActive('shopee')) {
    try {
      const r = await scrapeShopeeOffers(cfg.shopeeAffiliateTag || cfg.mlAffiliateTag, cfg.minDiscount);
      console.log(`[Scheduler] Shopee: ${r.length}`);
      allPromos.push(...r);
      updateSourceRun('shopee', r.length);
    } catch (err) { console.error('[Scheduler] Shopee erro:', err.message); }
    await delay(2000);
  }

  if (isSourceActive('shopee_kw')) {
    for (const kw of cfg.keywords.slice(0, 3)) {
      try {
        const r = await scrapeShopeeKeyword(kw, cfg.shopeeAffiliateTag || '', cfg.minDiscount);
        allPromos.push(...r);
        await delay(2000);
      } catch {}
    }
    updateSourceRun('shopee_kw', 0);
  }

  // ── Rakuten ─────────────────────────────────────────────
  if (isSourceActive('rakuten')) {
    try {
      const r = await scrapeRakutenOffers(cfg.mlAffiliateTag, cfg.minDiscount);
      console.log(`[Scheduler] Rakuten: ${r.length}`);
      allPromos.push(...r);
      updateSourceRun('rakuten', r.length);
    } catch (err) { console.error('[Scheduler] Rakuten erro:', err.message); }
    await delay(1500);
  }

  // ── Salva e posta ────────────────────────────────────────
  let savedCount = 0;
  for (const promo of allPromos) {
    if (savePromotion(promo)) savedCount++;
  }
  console.log(`[Scheduler] ${savedCount} novas promoções salvas (${allPromos.length} encontradas)`);

  const pending = getPendingPromotions();
  let postedCount = 0;
  for (const promo of pending) {
    const result = await sendPromotion(promo);
    if (result.success) { markAsPosted(promo.id); postedCount++; }
    await delay(3000);
  }

  console.log(`[Scheduler] ✓ Ciclo concluído: ${postedCount} postadas`);
  isRunning = false;
  return { success: true, found: allPromos.length, saved: savedCount, posted: postedCount };
}

function startScheduler() {
  const cfg = getConfig();
  const minutes = Math.max(cfg.intervalMinutes, 10);
  console.log(`[Scheduler] Intervalo: ${minutes} min`);
  cronJob = cron.schedule(`*/${minutes} * * * *`, async () => {
    await runScrapeAndPost();
    updateNextRun(minutes);
  });
  updateNextRun(minutes);
  setTimeout(async () => { await runScrapeAndPost(); updateNextRun(minutes); }, 5000);
}

function stopScheduler() { if (cronJob) cronJob.stop(); }
function updateNextRun(m) { nextRunAt = new Date(Date.now() + m * 60 * 1000); }
function getStatus() { return { isRunning, lastRunAt, nextRunAt, config: getConfig() }; }

module.exports = { startScheduler, stopScheduler, runScrapeAndPost, getStatus };
