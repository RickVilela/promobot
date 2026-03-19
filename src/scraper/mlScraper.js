const axios = require('axios');

// ─── IDs de categorias raiz do Brasil (validados via /sites/MLB/categories) ──
// Ref: https://api.mercadolibre.com/sites/MLB/categories
const ML_CATEGORIES = {
  eletronicos:      'MLB1000',  // Eletrônicos, Áudio e Vídeo
  celulares:        'MLB1051',  // Celulares e Telefones
  informatica:      'MLB1648',  // Computação (subcategoria — OK para highlights)
  eletrodomesticos: 'MLB5726',  // Eletrodomésticos (ID correto!)
  casa:             'MLB1574',  // Casa, Móveis e Decoração
  moda:             'MLB1430',  // Calçados, Roupas e Bolsas
  esportes:         'MLB1276',  // Esportes e Fitness
  games:            'MLB1144',  // Games e Consoles
  cameras:          'MLB1039',  // Câmeras e Acessórios
  bebes:            'MLB1384',  // Bebês
};

// Categorias para varredura automática de ofertas
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
// GET /highlights/MLB/category/{id} — retorna best sellers
// Funciona com token; retorna até 20 IDs por categoria
async function fetchHighlights(categoryId) {
  const url = `https://api.mercadolibre.com/highlights/MLB/category/${categoryId}`;
  const resp = await axios.get(url, {
    headers: { 'Accept': 'application/json', ...authHeader() },
    timeout: 12000,
  });
  const content = resp.data.content || [];
  return content.map(c => c.id).filter(Boolean);
}

// ─── 2. Detalhes em lote ─────────────────────────────────────────
// GET /items?ids=MLB1,MLB2&attributes=... — até 20 por chamada
async function fetchItemsBatch(ids) {
  if (!ids.length) return [];
  const results = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const url = `https://api.mercadolibre.com/items?ids=${chunk.join(',')}&attributes=id,title,thumbnail,permalink,category_id,seller,price,original_price`;
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

// ─── 3. Preço oficial via /items/{id}/prices ─────────────────────
// Retorna prices[].amount (atual) e prices[].regular_amount (original)
// regular_amount só aparece quando há promoção ativa no item
async function fetchPrice(itemId) {
  try {
    const url = `https://api.mercadolibre.com/items/${itemId}/prices`;
    const resp = await axios.get(url, {
      headers: { 'Accept': 'application/json', ...authHeader() },
      timeout: 8000,
    });
    const prices = resp.data.prices || [];
    // Pega o primeiro preço disponível (geralmente é o do canal marketplace)
    const p = prices[0];
    if (!p) return null;
    return {
      sale_price:     p.amount,
      original_price: p.regular_amount || null,
      currency:       resp.data.currency_id,
    };
  } catch { return null; }
}

// ─── 4. Preços em lote com concorrência controlada ───────────────
async function fetchPricesBatch(ids, concurrency = 8) {
  const priceMap = {};
  const queue = [...ids];
  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) break;
      const p = await fetchPrice(id);
      if (p) priceMap[id] = p;
      await delay(100);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return priceMap;
}

// ─── Pipeline principal ──────────────────────────────────────────
async function processIds(ids, affiliateTag, minDiscount) {
  if (!ids.length) return [];

  const items = await fetchItemsBatch(ids);
  if (!items.length) { console.log('[ML] Nenhum item retornado'); return []; }

  console.log(`[ML] Buscando preços de ${items.length} itens...`);
  const priceMap = await fetchPricesBatch(items.map(i => i.id));
  console.log(`[ML] ${Object.keys(priceMap).length} preços via /prices`);

  const results = [];
  for (const item of items) {
    // Prioridade: preço do endpoint /prices; fallback para campo price do item
    const pData     = priceMap[item.id];
    const salePrice = pData?.sale_price ?? item.price;
    if (!salePrice) continue;

    // Prioridade para original_price: /prices.regular_amount > item.original_price
    const originalPrice = pData?.original_price ?? item.original_price ?? null;

    let discountPercent = null;
    if (originalPrice && originalPrice > salePrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    // Filtra por desconto mínimo se calculado
    if (discountPercent !== null && discountPercent < minDiscount) continue;

    // Inclui itens SEM desconto calculado apenas se tiverem original_price
    // (significa que estão em promoção mas o desconto é pequeno ou a math não bateu)
    if (discountPercent === null && originalPrice === null) continue;

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

// ─── API pública ─────────────────────────────────────────────────

async function scrapeOffersOfDay(affiliateTag, minDiscount = 15) {
  if (!getToken()) { console.warn('[ML] Sem token — acesse /ml/auth'); return []; }
  console.log('[ML] Buscando highlights por categoria...');
  const all = [];

  for (const cat of OFFER_CATEGORIES) {
    try {
      console.log(`[ML] Highlights: ${cat.name} (${cat.id})`);
      const ids = await fetchHighlights(cat.id);
      console.log(`[ML] ${ids.length} IDs`);
      if (ids.length > 0) {
        const r = await processIds(ids, affiliateTag, minDiscount);
        all.push(...r);
        console.log(`[ML] ${r.length} promos em ${cat.name}`);
      }
      await delay(1000);
    } catch (err) {
      console.error(`[ML] Erro highlights ${cat.name}:`, err.response?.data?.message || err.message);
    }
  }

  const result = dedupe(all);
  console.log(`[ML] Total: ${result.length} promoções`);
  return result;
}

async function scrapeByKeyword(keyword, affiliateTag, minDiscount = 15) {
  // /search requer aprovação do app — não disponível em modo teste
  // Alternativa futura: quando o app for aprovado, descomentar abaixo
  console.log(`[ML] Keyword "${keyword}" — /search requer app aprovado, pulando`);
  return [];
}

async function scrapeByCategory(categoryKey, affiliateTag, minDiscount = 15) {
  if (!getToken()) return [];
  const categoryId = ML_CATEGORIES[categoryKey];
  if (!categoryId) { console.warn(`[ML] Categoria desconhecida: ${categoryKey}`); return []; }
  console.log(`[ML] Categoria: ${categoryKey} (${categoryId})`);
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