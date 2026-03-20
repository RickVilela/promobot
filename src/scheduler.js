const cron = require('node-cron');
const { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory } = require('./scraper/mlScraper');
const { scrapeShopeeOffers, scrapeShopeeKeyword } = require('./scraper/shopeeScraper');
const { scrapePelandoHot, scrapePelandoRecent } = require('./scraper/pelandoScraper');
const { scrapeRakutenOffers } = require('./scraper/rakutenScraper');
const { savePromotion, getPendingPromotions, markAsPosted, updateSourceRun, isSourceActive } = require('./db/database');
const { sendPromotion } = require('./bot/telegram');

let isRunning = false;
let lastRunAt = null;
let nextRunAt = null;
let cronJob = null;

function getConfig() {
  return {
    mlAffiliateTag:      process.env.ML_AFFILIATE_TAG || 'seutag-55',
    shopeeAffiliateTag:  process.env.SHOPEE_AFFILIATE_TAG || '',
    minDiscount:         parseInt(process.env.MIN_DISCOUNT_PERCENT || '15'),
    intervalMinutes:     parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '30'),
    keywords:            (process.env.SEARCH_KEYWORDS || '').split(',').map(k => k.trim()).filter(Boolean),
    categories:          (process.env.ML_CATEGORIES || 'eletronicos').split(',').map(c => c.trim()).filter(Boolean),
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runScrapeAndPost() {
  if (isRunning) { console.log('[Scheduler] Já em execução, pulando...'); return { skipped: true }; }

  isRunning = true;
  lastRunAt = new Date();
  console.log('\n[Scheduler] ═══ Iniciando ciclo de scraping ═══');

  const cfg = getConfig();
  const allPromos = [];

  // ── Mercado Livre ─────────────────────────────────────
  if (isSourceActive('ml_offers')) {
    try {
      const r = await scrapeOffersOfDay(cfg.mlAffiliateTag, cfg.minDiscount);
      console.log(`[Scheduler] ML Ofertas: ${r.length}`);
      allPromos.push(...r.map(p => ({ ...p, source: 'mercadolivre' })));
      updateSourceRun('ml_offers', r.length);
    } catch (err) { console.error('[Scheduler] ML Ofertas erro:', err.message); }
    await delay(2000);
  }

  if (isSourceActive('ml_keyword')) {
    for (const kw of cfg.keywords.slice(0, 5)) {
      try {
        const r = await scrapeByKeyword(kw, cfg.mlAffiliateTag, cfg.minDiscount);
        allPromos.push(...r.map(p => ({ ...p, source: 'mercadolivre' })));
        await delay(2000);
      } catch {}
    }
    updateSourceRun('ml_keyword', 0);
  }

  if (isSourceActive('ml_category')) {
    for (const cat of cfg.categories.slice(0, 3)) {
      try {
        const r = await scrapeByCategory(cat, cfg.mlAffiliateTag, cfg.minDiscount);
        allPromos.push(...r.map(p => ({ ...p, source: 'mercadolivre' })));
        await delay(2000);
      } catch {}
    }
    updateSourceRun('ml_category', 0);
  }

  // ── Shopee ─────────────────────────────────────────────
  if (isSourceActive('shopee')) {
    try {
      const r = await scrapeShopeeOffers(cfg.shopeeAffiliateTag || cfg.mlAffiliateTag, cfg.minDiscount);
      console.log(`[Scheduler] Shopee Ofertas: ${r.length}`);
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

  // ── Rakuten ────────────────────────────────────────────────
  if (isSourceActive('rakuten')) {
    try {
      const r = await scrapeRakutenOffers(cfg.mlAffiliateTag, cfg.minDiscount);
      console.log(`[Scheduler] Rakuten: ${r.length}`);
      allPromos.push(...r);
      updateSourceRun('rakuten', r.length);
    } catch (err) { console.error('[Scheduler] Rakuten erro:', err.message); }
    await delay(1500);
  }

  // ── Pelando ────────────────────────────────────────────────
  if (isSourceActive('pelando_hot')) {
    try {
      const tag = cfg.mlAffiliateTag;
      const r = await scrapePelandoHot(tag, cfg.minDiscount);
      console.log(`[Scheduler] Pelando Hot: ${r.length}`);
      allPromos.push(...r);
      updateSourceRun('pelando_hot', r.length);
    } catch (err) { console.error('[Scheduler] Pelando Hot erro:', err.message); }
    await delay(1500);
  }

  if (isSourceActive('pelando_recent')) {
    try {
      const tag = cfg.mlAffiliateTag;
      const r = await scrapePelandoRecent(tag, cfg.minDiscount);
      console.log(`[Scheduler] Pelando Recentes: ${r.length}`);
      allPromos.push(...r);
      updateSourceRun('pelando_recent', r.length);
    } catch (err) { console.error('[Scheduler] Pelando Recentes erro:', err.message); }
    await delay(1500);
  }

  // ── Salva e posta ──────────────────────────────────────
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