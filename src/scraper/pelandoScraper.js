const axios = require('axios');
const cheerio = require('cheerio');

// ─── URLs candidatas — testa em ordem até uma funcionar ──────────
// Para adicionar novas fontes, basta adicionar ao array FEEDS
const FEEDS = [
  // Hardmob Promoções (fórum vBulletin)
  { name: 'Hardmob', url: 'https://www.hardmob.com.br/external.php?type=RSS2&forumids=407&count=30' },
  { name: 'Hardmob', url: 'http://www.hardmob.com.br/external.php?type=RSS2&forumids=407&count=30' },
  { name: 'Hardmob', url: 'https://www.hardmob.com.br/forums/407-Promocoes?format=rss' },

  // Promobit
  { name: 'Promobit', url: 'https://www.promobit.com.br/feed/' },
  { name: 'Promobit', url: 'https://www.promobit.com.br/feed/rss/' },
  { name: 'Promobit', url: 'https://www.promobit.com.br/feed/rss2/' },

  // Zoom
  { name: 'Zoom', url: 'https://www.zoom.com.br/rss/ofertas' },
  { name: 'Zoom', url: 'https://www.zoom.com.br/feed/' },

  // Buscapé
  { name: 'Buscape', url: 'https://www.buscape.com.br/rss/ofertas' },
  { name: 'Buscape', url: 'https://www.buscape.com.br/feed/' },
];

// Feeds adicionais configuráveis via variável de ambiente
// Ex: EXTRA_RSS_FEEDS=https://meusite.com/feed,https://outro.com/rss
function getExtraFeeds() {
  const extra = process.env.EXTRA_RSS_FEEDS || '';
  return extra.split(',').filter(Boolean).map(url => ({ name: 'Custom', url: url.trim() }));
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Cache-Control': 'no-cache',
};

function buildAffiliateUrl(url, affiliateTag) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname.includes('mercadolivre') || u.hostname.includes('mercadolibre')) {
      u.searchParams.set('mt', affiliateTag);
    }
    return u.toString();
  } catch { return url; }
}

function extractPrice(text) {
  if (!text) return null;
  const match = text.replace(/R\$\s*/gi, '').match(/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/);
  if (!match) return null;
  const val = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
  return isNaN(val) || val <= 0 ? null : val;
}

function parsePrices(text) {
  if (!text) return {};
  const prices = [...text.matchAll(/R\$\s*[\d.,]+/gi)]
    .map(m => extractPrice(m[0]))
    .filter(Boolean);
  const salePrice = prices.length > 0 ? Math.min(...prices) : null;
  const originalPrice = prices.length > 1 ? Math.max(...prices) : null;
  const discountMatch = text.match(/(\d+)\s*%/);
  let discountPercent = discountMatch ? parseInt(discountMatch[1]) : null;
  if (!discountPercent && originalPrice && salePrice && originalPrice > salePrice) {
    discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  }
  return { salePrice, originalPrice, discountPercent };
}

function extractBuyLink(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const stores = ['amazon.com.br','mercadolivre','shopee.com.br','magazineluiza','americanas.com',
    'kabum.com','extra.com.br','casasbahia.com','pichau.com.br','aliexpress.com',
    'netshoes.com','centauro.com.br','carrefour.com.br'];
  let found = null;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (stores.some(s => href.includes(s))) { found = href; return false; }
  });
  return found;
}

// Testa um feed e retorna os itens ou null se falhar
async function tryFeed(feed, affiliateTag, minDiscount) {
  try {
    const resp = await axios.get(feed.url, {
      headers: HEADERS,
      timeout: 10000,
      maxRedirects: 3,
    });

    // Verifica se é XML/RSS válido
    const ct = resp.headers['content-type'] || '';
    const isXml = ct.includes('xml') || ct.includes('rss') || resp.data.trim().startsWith('<?xml');
    if (!isXml) return null;

    const $ = cheerio.load(resp.data, { xmlMode: true });
    const items = $('item');
    if (items.length === 0) return null;

    console.log(`[${feed.name}] ✓ Feed OK: ${feed.url} — ${items.length} itens`);

    const results = [];
    items.each((_, el) => {
      try {
        const $el = $(el);
        const title   = $el.find('title').first().text().trim();
        const link    = $el.find('link').first().text().trim() || $el.find('guid').text().trim();
        const desc    = $el.find('description').first().text();
        const pubDate = $el.find('pubDate').text();
        const encImg  = $el.find('enclosure[type^="image"]').attr('url') || null;

        if (!title || !link) return;
        if (pubDate && Date.now() - new Date(pubDate).getTime() > 48 * 3600 * 1000) return;

        const { salePrice, originalPrice, discountPercent } = parsePrices(title + ' ' + desc);
        if (!salePrice || !discountPercent || discountPercent < minDiscount) return;

        const buyLink = extractBuyLink(desc) || link;
        const storeMatch = title.match(/^\[([^\]]+)\]/);
        const store = storeMatch ? storeMatch[1] : feed.name;

        const cleanTitle = title.replace(/^\[[^\]]+\]\s*/, '').replace(/\s*[-–]\s*R\$[\d\s.,]+.*$/i, '').trim() || title;

        results.push({
          ml_id:            feed.name.toUpperCase() + '_' + Buffer.from(link).toString('base64').substr(0, 16).replace(/[/+=]/g,''),
          title:            cleanTitle.substring(0, 200),
          original_price:   originalPrice,
          sale_price:       salePrice,
          discount_percent: discountPercent,
          image_url:        encImg,
          original_url:     buyLink,
          affiliate_url:    buildAffiliateUrl(buyLink, affiliateTag),
          category:         store,
          seller:           store,
          source:           feed.name.toLowerCase(),
        });
      } catch {}
    });

    return results;
  } catch (err) {
    console.log(`[${feed.name}] ✗ ${feed.url} — ${err.message}`);
    return null;
  }
}

async function scrapePelandoHot(affiliateTag, minDiscount = 15) {
  const all = [];
  const allFeeds = [...FEEDS, ...getExtraFeeds()];
  const triedNames = new Set();

  for (const feed of allFeeds) {
    // Pula se já achou resultado dessa fonte (evita testar URLs duplicadas da mesma fonte)
    if (triedNames.has(feed.name) && all.some(r => r.source === feed.name.toLowerCase())) continue;

    const results = await tryFeed(feed, affiliateTag, minDiscount);
    if (results && results.length > 0) {
      triedNames.add(feed.name);
      all.push(...results);
      console.log(`[${feed.name}] ${results.length} promos com >= ${minDiscount}% desconto`);
      if (results[0]) console.log(`[${feed.name}] Ex: "${results[0].title.substring(0,45)}" | R$${results[0].sale_price} | -${results[0].discount_percent}%`);
    }
  }

  if (all.length === 0) {
    console.warn('[RSS] Nenhum feed funcionou. Verifique EXTRA_RSS_FEEDS no .env para adicionar feeds customizados.');
  }

  // Deduplica por título
  const seen = new Set();
  return all.filter(r => {
    const key = r.title.toLowerCase().substring(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scrapePelandoRecent(_a, _b) { return []; }

module.exports = { scrapePelandoHot, scrapePelandoRecent };
