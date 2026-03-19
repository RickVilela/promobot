const axios = require('axios');

const ML_CATEGORIES = {
  eletronicos:      'MLB1000',
  informatica:      'MLB1648',
  eletrodomesticos: 'MLB1574',
  moda:             'MLB1430',
  esportes:         'MLB1276',
  casa:             'MLB1459',
  celulares:        'MLB1051',
  games:            'MLB1144',
};

function getHeaders() {
  const token = process.env.ML_ACCESS_TOKEN;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };
  if (token && token !== 'seu_token_aqui') {
    headers['Authorization'] = 'Bearer ' + token;
  }
  return headers;
}

function buildAffiliateUrl(originalUrl, affiliateTag) {
  try {
    const url = new URL(originalUrl);
    url.searchParams.set('mt', affiliateTag);
    return url.toString();
  } catch {
    return originalUrl + (originalUrl.includes('?') ? '&' : '?') + 'mt=' + affiliateTag;
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function processItem(item, affiliateTag, minDiscount) {
  try {
    if (!item.price) return null;

    const salePrice     = item.price;
    const originalPrice = item.original_price || null;

    let discountPercent = null;
    if (originalPrice && originalPrice > salePrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    if (discountPercent !== null && discountPercent < minDiscount) return null;

    const imageUrl = item.thumbnail
      ? item.thumbnail.replace('-I.jpg', '-O.jpg').replace('-O.webp', '-O.jpg')
      : null;

    return {
      ml_id:            item.id,
      title:            (item.title || '').substring(0, 200),
      original_price:   originalPrice,
      sale_price:       salePrice,
      discount_percent: discountPercent,
      image_url:        imageUrl,
      original_url:     item.permalink,
      affiliate_url:    buildAffiliateUrl(item.permalink, affiliateTag),
      category:         item.category_id || 'geral',
      seller:           item.seller?.nickname || null,
    };
  } catch {
    return null;
  }
}

async function fetchML(params, affiliateTag, minDiscount) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.mercadolibre.com/sites/MLB/search?${qs}`;
  console.log('[Scraper] GET', url);

  const resp = await axios.get(url, { headers: getHeaders(), timeout: 15000 });
  const items = resp.data.results || [];
  console.log(`[Scraper] ${items.length} itens — com token: ${!!process.env.ML_ACCESS_TOKEN}`);

  const results = [];
  for (const item of items) {
    const p = processItem(item, affiliateTag, minDiscount);
    if (p) results.push(p);
  }
  return results;
}

async function scrapeOffersOfDay(affiliateTag, minDiscount = 15) {
  const all = [];
  console.log('[Scraper] Buscando ofertas do dia...');

  const searches = [
    { category: 'MLB1000', sort: 'relevance', limit: 50, condition: 'new' }, // eletrônicos
    { category: 'MLB1648', sort: 'relevance', limit: 50, condition: 'new' }, // informática
    { category: 'MLB1574', sort: 'relevance', limit: 50, condition: 'new' }, // eletrodomésticos
    { category: 'MLB1051', sort: 'relevance', limit: 50, condition: 'new' }, // celulares
  ];

  for (const params of searches) {
    try {
      const r = await fetchML(params, affiliateTag, minDiscount);
      all.push(...r);
      await delay(1500);
    } catch (err) {
      console.error('[Scraper] Erro:', err.message);
    }
  }

  // Remove duplicatas
  const seen = new Set();
  return all.filter(r => {
    if (seen.has(r.ml_id)) return false;
    seen.add(r.ml_id);
    return true;
  });
}

async function scrapeByKeyword(keyword, affiliateTag, minDiscount = 15) {
  console.log(`[Scraper] Keyword: "${keyword}"`);
  try {
    return await fetchML({ q: keyword, sort: 'relevance', limit: 30, condition: 'new' }, affiliateTag, minDiscount);
  } catch (err) {
    console.error(`[Scraper] Erro keyword "${keyword}":`, err.message);
    return [];
  }
}

async function scrapeByCategory(categoryKey, affiliateTag, minDiscount = 15) {
  const categoryId = ML_CATEGORIES[categoryKey];
  if (!categoryId) return [];
  console.log(`[Scraper] Categoria: ${categoryKey}`);
  try {
    return await fetchML({ category: categoryId, sort: 'relevance', limit: 30, condition: 'new' }, affiliateTag, minDiscount);
  } catch (err) {
    console.error(`[Scraper] Erro categoria "${categoryKey}":`, err.message);
    return [];
  }
}

module.exports = { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory, buildAffiliateUrl };