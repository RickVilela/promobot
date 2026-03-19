const cron = require('node-cron');
const { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory } = require('./scraper/mlScraper');
const { savePromotion, getPendingPromotions, markAsPosted } = require('./db/database');
const { sendPromotion } = require('./bot/telegram');

let isRunning = false;
let lastRunAt = null;
let nextRunAt = null;
let cronJob = null;

function getConfig() {
  return {
    affiliateTag: process.env.ML_AFFILIATE_TAG || 'seutag-55',
    minDiscount: parseInt(process.env.MIN_DISCOUNT_PERCENT || '15'),
    intervalMinutes: parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '30'),
    keywords: (process.env.SEARCH_KEYWORDS || '').split(',').map(k => k.trim()).filter(Boolean),
    categories: (process.env.ML_CATEGORIES || 'eletronicos').split(',').map(c => c.trim()).filter(Boolean),
  };
}

async function runScrapeAndPost() {
  if (isRunning) {
    console.log('[Scheduler] Ciclo já em execução, pulando...');
    return { skipped: true };
  }

  isRunning = true;
  lastRunAt = new Date();
  console.log('\n[Scheduler] ═══ Iniciando ciclo de scraping ═══');

  const cfg = getConfig();
  const newPromos = [];
  const errors = [];

  try {
    // 1. Busca ofertas do dia
    const offers = await scrapeOffersOfDay(cfg.affiliateTag, cfg.minDiscount);
    console.log(`[Scheduler] Ofertas do dia: ${offers.length} encontradas`);
    newPromos.push(...offers);

    // 2. Busca por palavras-chave configuradas
    for (const keyword of cfg.keywords.slice(0, 5)) {
      await delay(2000); // Respeita rate limit
      const kResults = await scrapeByKeyword(keyword, cfg.affiliateTag, cfg.minDiscount);
      newPromos.push(...kResults);
    }

    // 3. Busca por categorias
    for (const cat of cfg.categories.slice(0, 3)) {
      await delay(2000);
      const cResults = await scrapeByCategory(cat, cfg.affiliateTag, cfg.minDiscount);
      newPromos.push(...cResults);
    }

    // Salva no banco (apenas novas)
    let savedCount = 0;
    for (const promo of newPromos) {
      const isNew = savePromotion(promo);
      if (isNew) savedCount++;
    }
    console.log(`[Scheduler] ${savedCount} novas promoções salvas (${newPromos.length} encontradas)`);

    // 4. Posta no Telegram
    const pending = getPendingPromotions();
    console.log(`[Scheduler] ${pending.length} promoções para postar`);

    let postedCount = 0;
    for (const promo of pending) {
      const result = await sendPromotion(promo);
      if (result.success) {
        markAsPosted(promo.id);
        postedCount++;
        // Aguarda entre posts para não spammar
        await delay(3000);
      }
    }

    console.log(`[Scheduler] ✓ Ciclo concluído: ${postedCount} promoções postadas`);
    return { success: true, found: newPromos.length, saved: savedCount, posted: postedCount };

  } catch (err) {
    console.error('[Scheduler] Erro no ciclo:', err);
    errors.push(err.message);
    return { success: false, errors };
  } finally {
    isRunning = false;
  }
}

function startScheduler() {
  const cfg = getConfig();
  const minutes = Math.max(cfg.intervalMinutes, 10); // Mínimo 10 min

  console.log(`[Scheduler] Iniciando com intervalo de ${minutes} minutos`);

  // Agenda o cron
  const cronExpr = `*/${minutes} * * * *`;
  cronJob = cron.schedule(cronExpr, async () => {
    await runScrapeAndPost();
    updateNextRun(minutes);
  });

  updateNextRun(minutes);

  // Executa imediatamente ao iniciar (com delay de 5s)
  setTimeout(async () => {
    console.log('[Scheduler] Execução inicial...');
    await runScrapeAndPost();
    updateNextRun(minutes);
  }, 5000);
}

function stopScheduler() {
  if (cronJob) {
    cronJob.stop();
    console.log('[Scheduler] Parado.');
  }
}

function updateNextRun(minutes) {
  nextRunAt = new Date(Date.now() + minutes * 60 * 1000);
}

function getStatus() {
  return {
    isRunning,
    lastRunAt,
    nextRunAt,
    config: getConfig(),
  };
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { startScheduler, stopScheduler, runScrapeAndPost, getStatus };
