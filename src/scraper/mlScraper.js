const axios = require('axios');

// ─── Endpoints usados (documentação oficial ML) ─────────────────
// Highlights (best sellers por categoria) — requer token:
//   GET /highlights/MLB/category/{category_id}
//   Retorna: { content: [{id, position, type}] }
//
// Detalhes de itens em lote — requer token:
//   GET /items?ids=MLB1,MLB2&attributes=id,title,thumbnail,permalink,seller
//
// Preços oficiais — requer token:
//   GET /items/{id}/prices
//   Retorna: { prices: [{type, amount, regular_amount, ...}] }
//   regular_amount = preço original quando há promoção ativa
//
// Ref: https://developers.mercadolivre.com.br/pt_br/api-de-precos
//      https://developers.mercadolibre.com.ar/en_us/best-sellers-in-mercado-libre

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

// Categorias populares para varredura de ofertas
const OFFER_CATEGORIES = [
  'MLB1051', // celulares
  'MLB1000', // eletrônicos
  'MLB1648', // informática
  'MLB1574', // eletrodomésticos
  'MLB1276', // esportes
  'MLB1459', // casa
];

function getToken() {
  return process.env.ML_ACCESS_TOKEN || null;
}

function authHeader() {
  const t = getToken();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}

function buildAffiliateUrl(url, tag) {
  try {
    const u = new URL(url);
    u.searchParams.set('mt', tag);
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + 'mt=' + tag;
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── 1. Highlights: best sellers de uma categoria ───────────────
async function fetchHighlights(categoryId) {
  const url = `https://api.mercadolibre.com/highlights/MLB/category/${categoryId}`;
  const resp = await axios.get(url, {
    headers: { 'Accept': 'application/json', ...authHeader() },
    timeout: 12000,
  });
  const content = resp.data.content || [];
  return content.filter(c => c.type === 'ITEM').map(c => c.id);
}

// ─── 2. Detalhes em lote via /items?ids= ────────────────────────
async function fetchItemsBatch(ids) {
  if (!ids.length) return [];
  const results = [];

  // ML aceita até 20 por chamada
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const url = `https://api.mercadolibre.com/items?ids=${chunk.join(',')}&attributes=id,title,thumbnail,permalink,category_id,seller`;
      const resp = await axios.get(url, {
        headers: { 'Accept': 'application/json', ...authHeader() },
        timeout: 12000,
      });
      for (const entry of (resp.data || [])) {
        if (entry.code === 200 && entry.body) results.push(entry.body);
      }
      await delay(300);
    } catch (err) {
      console.error('[ML] Erro /items batch:', err.message);
    }
  }
  return results;
}

// ─── 3. Preços via /items/{id}/prices (API oficial) ─────────────
// Retorna amount (preço atual) e regular_amount (original se em promoção)
async function fetchPrice(itemId) {
  try {
    const url = `https://api.mercadolibre.com/items/${itemId}/prices`;
    const resp = await axios.get(url, {
      headers: { 'Accept': 'application/json', ...authHeader() },
      timeout: 8000,
    });

    // Procura o preço do canal "marketplace" (canal principal de compras)
    const prices = resp.data.prices || [];
    const marketplace = prices.find(p =>
      p.conditions?.context_restrictions?.includes('channel_marketplace') ||
      p.type === 'standard' ||
      prices.indexOf(p) === 0
    );

    if (!marketplace) return null;

    return {
      sale_price:     marketplace.amount,
      original_price: marketplace.regular_amount || null,
      currency:       resp.data.currency_id,
    };
  } catch {
    return null;
  }
}

// ─── 4. Preços em lote (paralelo com controle de concorrência) ──
async function fetchPricesBatch(ids, concurrency = 5) {
  const priceMap = {};
  const queue = [...ids];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      const p = await fetchPrice(id);
      if (p) priceMap[id] = p;
      await delay(150); // respeita rate limit ML
    }
  }

  // Roda N workers em paralelo
  await Promise.all(Array.from({ length: concurrency }, worker));
  return priceMap;
}

// ─── Pipeline principal ─────────────────────────────────────────
async function processIds(ids, affiliateTag, minDiscount, itemDetails = null) {
  if (!ids.length) return [];

  // Busca detalhes se não foram fornecidos
  const items = itemDetails || await fetchItemsBatch(ids);
  if (!items.length) return [];

  console.log(`[ML] Buscando preços de ${items.length} itens...`);
  const priceMap = await fetchPricesBatch(items.map(i => i.id));
  console.log(`[ML] ${Object.keys(priceMap).length} preços obtidos`);

  const results = [];
  for (const item of items) {
    const p = priceMap[item.id];
    if (!p || !p.sale_price) continue;

    const salePrice     = p.sale_price;
    const originalPrice = p.original_price;

    let discountPercent = null;
    if (originalPrice && originalPrice > salePrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    // Só pula se calculou desconto e é menor que o mínimo
    if (discountPercent !== null && discountPercent < minDiscount) continue;
    // Sem desconto calculado e não tem original_price → skip (preço normal, não é promoção)
    if (discountPercent === null && !originalPrice) continue;

    const imageUrl = (item.thumbnail || '')
      .replace('http://', 'https://')
      .replace(/\/[A-Z]_NP_/, '/D_NP_')
      .replace(/-[A-Z]\.jpg$/, '-O.jpg');

    results.push({
      ml_id:            item.id,
      title:            (item.title || '').substring(0, 200),
      original_price:   originalPrice,
      sale_price:       salePrice,
      discount_percent: discountPercent,
      image_url:        imageUrl.startsWith('https') ? imageUrl : null,
      original_url:     item.permalink,
      affiliate_url:    buildAffiliateUrl(item.permalink, affiliateTag),
      category:         item.category_id || 'geral',
      seller:           item.seller?.nickname || null,
      source:           'mercadolivre',
    });
  }

  if (results.length > 0) {
    const ex = results[0];
    console.log(`[ML] Ex: "${ex.title.substring(0,45)}" | R$${ex.sale_price} (era R$${ex.original_price}) | -${ex.discount_percent}%`);
  }

  return results;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(r => { if (seen.has(r.ml_id)) return false; seen.add(r.ml_id); return true; });
}

// ─── API pública ────────────────────────────────────────────────

async function scrapeOffersOfDay(affiliateTag, minDiscount = 15) {
  console.log('[ML] Buscando highlights por categoria...');

  const token = getToken();
  if (!token) {
    console.warn('[ML] Sem token — autentique em /ml/auth');
    return [];
  }

  const all = [];
  for (const catId of OFFER_CATEGORIES) {
    try {
      console.log(`[ML] Highlights categoria ${catId}...`);
      const ids = await fetchHighlights(catId);
      console.log(`[ML] ${ids.length} IDs de highlights`);
      if (!ids.length) continue;

      const r = await processIds(ids, affiliateTag, minDiscount);
      all.push(...r);
      await delay(1000);
    } catch (err) {
      console.error(`[ML] Erro highlights ${catId}:`, err.response?.data?.message || err.message);
    }
  }

  const result = dedupe(all);
  console.log(`[ML] Total ofertas do dia: ${result.length}`);
  return result;
}

async function scrapeByKeyword(keyword, affiliateTag, minDiscount = 15) {
  // Keyword search requer aprovação do app no ML
  // Alternativa: buscar nos highlights das categorias relevantes
  console.log(`[ML] Keyword "${keyword}" — usando highlights gerais`);
  return [];
}

async function scrapeByCategory(categoryKey, affiliateTag, minDiscount = 15) {
  const categoryId = ML_CATEGORIES[categoryKey];
  if (!categoryId) return [];

  const token = getToken();
  if (!token) return [];

  console.log(`[ML] Categoria: ${categoryKey} (${categoryId})`);
  try {
    const ids = await fetchHighlights(categoryId);
    if (!ids.length) return [];
    return await processIds(ids, affiliateTag, minDiscount);
  } catch (err) {
    console.error(`[ML] Erro categoria "${categoryKey}":`, err.response?.data?.message || err.message);
    return [];
  }
}

module.exports = { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory, buildAffiliateUrl };