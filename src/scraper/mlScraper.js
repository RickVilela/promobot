const axios = require('axios');

// ─── Endpoints confirmados com token de app em modo teste ────────
// GET /highlights/MLB/category/{id}  → IDs dos best sellers  ✓
// GET /items/{id}                    → detalhes do item       ✓
// GET /items/{id}/prices             → preço atual + original ✓
// GET /items?ids=...                 → BLOQUEADO (requer app aprovado)
// GET /sites/MLB/search              → BLOQUEADO (requer app aprovado)

const ML_CATEGORIES = {
  eletronicos:      'MLB1000',
  celulares:        'MLB1051',
  informatica:      'MLB1648',
  eletrodomesticos: 'MLB5726',
  casa:             'MLB1574',
  moda:             'MLB1430',
  esportes:         'MLB1276',
  games:            'MLB1144',
};

const OFFER_CATEGORIES = [
  { id: 'MLB1051', name: 'Celulares' },
  { id: 'MLB1000', name: 'Eletrônicos' },
  { id: 'MLB5726', name: 'Eletrodomésticos' },
  { id: 'MLB1574', name: 'Casa e Móveis' },
  { id: 'MLB1276', name: 'Esportes' },
  { id: 'MLB1430', name: 'Moda' },
  { id: 'MLB1132', name: 'Brinquedos' },
  { id: 'MLB1246', name: 'Beleza' },
];

function getToken() { return process.env.ML_ACCESS_TOKEN || null; }
function authHeader() {
  const t = getToken();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}
function buildAffiliateUrl(url, tag) {
  try { const u = new URL(url); u.searchParams.set('mt', tag); return u.toString(); }
  catch { return url + (url.includes('?') ? '&' : '?') + 'mt=' + tag; }
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── 1. Highlights por categoria ────────────────────────────────
async function fetchHighlights(categoryId) {
  const url = `https://api.mercadolibre.com/highlights/MLB/category/${categoryId}`;
  const resp = await axios.get(url, {
    headers: { 'Accept': 'application/json', ...authHeader() },
    timeout: 12000,
  });
  return (resp.data.content || []).map(c => c.id).filter(Boolean);
}

// ─── 2. Item individual — confirmado funcionar com token ─────────
async function fetchItem(id) {
  try {
    const url = `https://api.mercadolibre.com/items/${id}`;
    const resp = await axios.get(url, {
      headers: { 'Accept': 'application/json', ...authHeader() },
      timeout: 8000,
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`[ML] Erro /items/${id}:`, err.response?.data?.message || err.message);
    }
    return null;
  }
}

// ─── 3. Preço via /items/{id}/prices ────────────────────────────
// amount = preço atual; regular_amount = original se em promoção
async function fetchPrice(id) {
  try {
    const url = `https://api.mercadolibre.com/items/${id}/prices`;
    const resp = await axios.get(url, {
      headers: { 'Accept': 'application/json', ...authHeader() },
      timeout: 8000,
    });
    const prices = resp.data.prices || [];
    const p = prices[0];
    if (!p) return null;
    return {
      sale_price:     p.amount,
      original_price: p.regular_amount || null,
    };
  } catch { return null; }
}

// ─── 4. Busca item + preço em paralelo com concorrência ─────────
async function fetchItemAndPrice(id) {
  const [item, price] = await Promise.all([fetchItem(id), fetchPrice(id)]);
  return { item, price };
}

async function fetchAllWithConcurrency(ids, concurrency = 5) {
  const results = [];
  const queue = [...ids];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      const data = await fetchItemAndPrice(id);
      results.push({ id, ...data });
      await delay(200);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Pipeline principal ──────────────────────────────────────────
async function processIds(ids, affiliateTag, minDiscount) {
  if (!ids.length) return [];
  console.log(`[ML] Buscando ${ids.length} itens (item + price em paralelo)...`);

  const fetched = await fetchAllWithConcurrency(ids);
  const promos = [];

  for (const { id, item, price } of fetched) {
    if (!item) continue;

    const salePrice     = price?.sale_price     ?? item.price;
    const originalPrice = price?.original_price ?? item.original_price ?? null;

    if (!salePrice) continue;

    let discountPercent = null;
    if (originalPrice && originalPrice > salePrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    // Filtra: precisa ter desconto real acima do mínimo
    if (discountPercent === null) continue;
    if (discountPercent < minDiscount) continue;

    const imageUrl = ((item.pictures?.[0]?.url || item.thumbnail || '')
      .replace('http://', 'https://')
      .replace(/\/[A-Z]_NP_/, '/D_NP_')
      .replace(/-[A-Z]\.jpg$/, '-O.jpg'));

    promos.push({
      ml_id:            item.id,
      title:            (item.title || '').substring(0, 200),
      original_price:   originalPrice,
      sale_price:       salePrice,
      discount_percent: discountPercent,
      image_url:        imageUrl.startsWith('https') ? imageUrl : null,
      original_url:     item.permalink,
      affiliate_url:    buildAffiliateUrl(item.permalink, affiliateTag),
      category:         item.category_id || 'geral',
      seller:           item.seller_id ? String(item.seller_id) : null,
      source:           'mercadolivre',
    });
  }

  if (promos.length > 0) {
    const ex = promos[0];
    console.log(`[ML] Ex: "${ex.title.substring(0,45)}" | R$${ex.sale_price} (era R$${ex.original_price}) | -${ex.discount_percent}%`);
  }
  return promos;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(r => { if (seen.has(r.ml_id)) return false; seen.add(r.ml_id); return true; });
}

// ─── API pública ─────────────────────────────────────────────────
async function scrapeOffersOfDay(affiliateTag, minDiscount = 15) {
  if (!getToken()) { console.warn('[ML] Sem token — acesse /ml/auth'); return []; }
  console.log('[ML] Buscando highlights por categoria...');
  const all = [];

  for (const cat of OFFER_CATEGORIES) {
    try {
      const ids = await fetchHighlights(cat.id);
      console.log(`[ML] ${cat.name}: ${ids.length} IDs`);
      if (!ids.length) continue;
      const r = await processIds(ids, affiliateTag, minDiscount);
      console.log(`[ML] ${cat.name}: ${r.length} promos`);
      all.push(...r);
      await delay(500);
    } catch (err) {
      console.error(`[ML] Erro ${cat.name}:`, err.response?.data?.message || err.message);
    }
  }

  const result = dedupe(all);
  console.log(`[ML] Total: ${result.length} promoções`);
  return result;
}

async function scrapeByKeyword(_keyword, _affiliateTag, _minDiscount) {
  // /search bloqueado para apps não aprovados
  return [];
}

async function scrapeByCategory(categoryKey, affiliateTag, minDiscount = 15) {
  if (!getToken()) return [];
  const categoryId = ML_CATEGORIES[categoryKey];
  if (!categoryId) return [];
  try {
    const ids = await fetchHighlights(categoryId);
    if (!ids.length) return [];
    return await processIds(ids, affiliateTag, minDiscount);
  } catch (err) {
    console.error(`[ML] Erro ${categoryKey}:`, err.response?.data?.message || err.message);
    return [];
  }
}

module.exports = { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory, buildAffiliateUrl };