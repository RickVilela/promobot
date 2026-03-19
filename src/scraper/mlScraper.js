const axios = require('axios');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

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

    // Só filtra se tiver desconto calculado e for menor que o mínimo
    if (discountPercent !== null && discountPercent < minDiscount) return null;

    // Melhora qualidade da imagem
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

// Endpoint público que não precisa de autenticação
async function fetchPublic(params, affiliateTag, minDiscount) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.mercadolibre.com/sites/MLB/search?${qs}`;
  console.log('[Scraper] GET', url);

  const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const items = resp.data.results || [];
  console.log(`[Scraper] ${items.length} itens recebidos`);

  const results = [];
  for (const item of items) {
    const p = processItem(item, affiliateTag, minDiscount);
    if (p) results.push(p);
  }
  return results;
}

async function scrapeOffersOfDay(affiliateTag, minDiscount = 15) {
  const results = [];
  console.log('[Scraper] Buscando ofertas do dia...');

  // Busca 1: mais vendidos com desconto, sem tag restrita
  try {
    const r = await fetchPublic({
      sort: 'relevance',
      limit: 50,
      condition: 'new',
    }, affiliateTag, minDiscount);
    results.push(...r);
  } catch (err) {
    console.error('[Scraper] Busca 1 falhou:', err.message);
  }

  await delay(1500);

  // Busca 2: por categoria eletrônicos (mais promoções)
  try {
    const r = await fetchPublic({
      category: 'MLB1000',
      sort: 'relevance',
      limit: 50,
      condition: 'new',
    }, affiliateTag, minDiscount);
    results.push(...r);
  } catch (err) {
    console.error('[Scraper] Busca 2 falhou:', err.message);
  }

  await delay(1500);

  // Busca 3: eletrodomésticos
  try {
    const r = await fetchPublic({
      category: 'MLB1574',
      sort: 'relevance',
      limit: 50,
      condition: 'new',
    }, affiliateTag, minDiscount);
    results.push(...r);
  } catch (err) {
    console.error('[Scraper] Busca 3 falhou:', err.message);
  }

  // Remove duplicatas por ml_id
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.ml_id)) return false;
    seen.add(r.ml_id);
    return true;
  });
}

async function scrapeByKeyword(keyword, affiliateTag, minDiscount = 15) {
  console.log(`[Scraper] Buscando: "${keyword}"`);
  try {
    return await fetchPublic({
      q: keyword,
      sort: 'relevance',
      limit: 30,
      condition: 'new',
    }, affiliateTag, minDiscount);
  } catch (err) {
    console.error(`[Scraper] Erro keyword "${keyword}":`, err.message);
    return [];
  }
}

async function scrapeByCategory(categoryKey, affiliateTag, minDiscount = 15) {
  const categoryId = ML_CATEGORIES[categoryKey];
  if (!categoryId) return [];
  console.log(`[Scraper] Buscando categoria: ${categoryKey}`);
  try {
    return await fetchPublic({
      category: categoryId,
      sort: 'relevance',
      limit: 30,
      condition: 'new',
    }, affiliateTag, minDiscount);
  } catch (err) {
    console.error(`[Scraper] Erro categoria "${categoryKey}":`, err.message);
    return [];
  }
}

module.exports = { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory, buildAffiliateUrl };