const axios = require('axios');

// ─── Documentação oficial usada ────────────────────────────────
// Search:     GET /sites/MLB/search?q=...&access_token=TOKEN
// Item price: GET /items/{id}/sale_price?context=channel_marketplace
//             Retorna: { amount (preço atual), regular_amount (preço original se em promoção) }
// Multi-item: GET /items?ids=MLB1,MLB2&attributes=id,title,thumbnail,permalink,original_price
// Ref: https://developers.mercadolivre.com.br/pt_br/api-de-precos

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

function getToken() {
  return process.env.ML_ACCESS_TOKEN || null;
}

function authHeaders() {
  const token = getToken();
  return token ? { 'Authorization': 'Bearer ' + token } : {};
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

// ─── Passo 1: busca IDs via /search ────────────────────────────
async function searchIds(params) {
  const token = getToken();
  const qs = new URLSearchParams(params);
  if (token) qs.set('access_token', token);

  const url = `https://api.mercadolibre.com/sites/MLB/search?${qs}`;
  console.log('[ML] Search:', url.replace(token || '', 'TOKEN'));

  const resp = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...authHeaders() },
    timeout: 15000,
  });

  return (resp.data.results || []).map(r => r.id).filter(Boolean);
}

// ─── Passo 2: busca detalhes em lote via /items?ids= ───────────
// Retorna title, thumbnail, permalink, original_price (campo legado, ainda disponível)
async function fetchItemsBatch(ids) {
  if (!ids.length) return [];
  const token = getToken();

  // Máximo 20 por chamada (limite ML)
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

  const allItems = [];
  for (const chunk of chunks) {
    try {
      const qs = new URLSearchParams({
        ids: chunk.join(','),
        attributes: 'id,title,thumbnail,permalink,price,original_price,currency_id',
      });
      if (token) qs.set('access_token', token);

      const url = `https://api.mercadolibre.com/items?${qs}`;
      const resp = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...authHeaders() },
        timeout: 15000,
      });

      for (const entry of (resp.data || [])) {
        if (entry.code === 200 && entry.body) allItems.push(entry.body);
      }
      await delay(300);
    } catch (err) {
      console.error('[ML] Erro batch /items:', err.message);
    }
  }
  return allItems;
}

// ─── Passo 3: busca preço real via /sale_price (API oficial) ───
// É o endpoint correto segundo a documentação — retorna amount + regular_amount
async function fetchSalePrices(ids) {
  const token = getToken();
  if (!token) return {}; // sale_price requer token

  const priceMap = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

  for (const chunk of chunks) {
    // ML suporta multi-get: /items/price?ids=MLB1,MLB2
    try {
      const url = `https://api.mercadolibre.com/items/prices?ids=${chunk.join(',')}&context=channel_marketplace`;
      const resp = await axios.get(url, {
        headers: { 'Accept': 'application/json', ...authHeaders() },
        timeout: 15000,
      });

      for (const entry of (resp.data || [])) {
        if (entry.code === 200 && entry.body) {
          // body: { amount, regular_amount, currency_id }
          priceMap[entry.id] = {
            sale_price:     entry.body.amount,
            original_price: entry.body.regular_amount || null,
          };
        }
      }
    } catch (err) {
      // Fallback: tenta um a um se o batch falhar
      for (const id of chunk) {
        try {
          const url = `https://api.mercadolibre.com/items/${id}/sale_price?context=channel_marketplace`;
          const resp = await axios.get(url, {
            headers: { 'Accept': 'application/json', ...authHeaders() },
            timeout: 8000,
          });
          priceMap[id] = {
            sale_price:     resp.data.amount,
            original_price: resp.data.regular_amount || null,
          };
          await delay(100);
        } catch {}
      }
    }
    await delay(500);
  }

  return priceMap;
}

// ─── Montagem final do objeto promoção ─────────────────────────
function buildPromo(item, priceData, affiliateTag, minDiscount) {
  const salePrice     = priceData?.sale_price     ?? item.price;
  const originalPrice = priceData?.original_price ?? item.original_price ?? null;

  if (!salePrice) return null;

  let discountPercent = null;
  if (originalPrice && originalPrice > salePrice) {
    discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  }

  if (discountPercent !== null && discountPercent < minDiscount) return null;

  // Melhora resolução da imagem (D = maior resolução)
  const imageUrl = (item.thumbnail || '')
    .replace('http://', 'https://')
    .replace(/\/[A-Z]_NP_/g, '/D_NP_')
    .replace(/-[A-Z]\.jpg/, '-O.jpg') || null;

  return {
    ml_id:            item.id,
    title:            (item.title || '').substring(0, 200),
    original_price:   originalPrice,
    sale_price:       salePrice,
    discount_percent: discountPercent,
    image_url:        imageUrl && imageUrl.startsWith('http') ? imageUrl : null,
    original_url:     item.permalink,
    affiliate_url:    buildAffiliateUrl(item.permalink, affiliateTag),
    category:         item.category_id || 'geral',
    seller:           item.seller?.nickname || null,
    source:           'mercadolivre',
  };
}

// ─── Pipeline completo: search → items → sale_price ─────────────
async function fetchWithPrices(searchParams, affiliateTag, minDiscount) {
  // 1. Busca IDs
  let ids;
  try {
    ids = await searchIds(searchParams);
  } catch (err) {
    console.error('[ML] Erro no search:', err.response?.data?.message || err.message);
    return [];
  }

  if (!ids.length) { console.log('[ML] Nenhum ID retornado'); return []; }
  console.log(`[ML] ${ids.length} IDs encontrados`);

  // 2. Detalhes dos itens (título, imagem, permalink)
  const items = await fetchItemsBatch(ids);
  console.log(`[ML] ${items.length} itens com detalhes`);

  // 3. Preços reais via sale_price (se tiver token)
  const token = getToken();
  let priceMap = {};
  if (token) {
    priceMap = await fetchSalePrices(ids);
    console.log(`[ML] ${Object.keys(priceMap).length} preços obtidos via sale_price`);
  } else {
    console.log('[ML] Sem token — usando original_price do /items (campo legado)');
  }

  // 4. Monta os objetos finais
  const results = [];
  for (const item of items) {
    const promo = buildPromo(item, priceMap[item.id], affiliateTag, minDiscount);
    if (promo) results.push(promo);
  }

  if (results.length > 0) {
    const ex = results[0];
    console.log(`[ML] Ex: "${ex.title.substring(0,45)}" | sale: R$${ex.sale_price} | orig: R$${ex.original_price} | desc: ${ex.discount_percent}%`);
  }

  return results;
}

// ─── API pública ───────────────────────────────────────────────

async function scrapeOffersOfDay(affiliateTag, minDiscount = 15) {
  console.log('[ML] Buscando ofertas do dia...');
  const all = [];

  const searches = [
    { category: 'MLB1000', sort: 'relevance', limit: 50 }, // eletrônicos
    { category: 'MLB1051', sort: 'relevance', limit: 50 }, // celulares
    { category: 'MLB1648', sort: 'relevance', limit: 50 }, // informática
    { category: 'MLB1574', sort: 'relevance', limit: 50 }, // eletrodomésticos
  ];

  for (const params of searches) {
    try {
      const r = await fetchWithPrices(params, affiliateTag, minDiscount);
      all.push(...r);
      await delay(1500);
    } catch (err) {
      console.error('[ML] Erro categoria:', err.message);
    }
  }

  return dedupe(all);
}

async function scrapeByKeyword(keyword, affiliateTag, minDiscount = 15) {
  console.log(`[ML] Keyword: "${keyword}"`);
  try {
    return await fetchWithPrices({ q: keyword, sort: 'relevance', limit: 30 }, affiliateTag, minDiscount);
  } catch (err) {
    console.error(`[ML] Erro keyword "${keyword}":`, err.message);
    return [];
  }
}

async function scrapeByCategory(categoryKey, affiliateTag, minDiscount = 15) {
  const categoryId = ML_CATEGORIES[categoryKey];
  if (!categoryId) return [];
  console.log(`[ML] Categoria: ${categoryKey}`);
  try {
    return await fetchWithPrices({ category: categoryId, sort: 'relevance', limit: 30 }, affiliateTag, minDiscount);
  } catch (err) {
    console.error(`[ML] Erro categoria "${categoryKey}":`, err.message);
    return [];
  }
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(r => {
    if (seen.has(r.ml_id)) return false;
    seen.add(r.ml_id);
    return true;
  });
}

module.exports = { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory, buildAffiliateUrl };