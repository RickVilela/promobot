const axios = require('axios');

// Pelando.com.br — API GraphQL pública (sem autenticação)
// Agrega promoções de Amazon, ML, Shopee, Magalu, KaBum, etc.
// Os usuários postam com preço original e preço com desconto

const PELANDO_API = 'https://api.pelando.com.br/api/v2/graphql';

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Origin': 'https://www.pelando.com.br',
  'Referer': 'https://www.pelando.com.br/',
};

// Query GraphQL para buscar promoções quentes
const QUERY_HOT = `
  query GetHotDeals($page: Int, $size: Int) {
    threads(
      filter: HOT
      page: $page
      size: $size
    ) {
      edges {
        node {
          id
          title
          price
          nextBestPrice
          discountFixed
          discountPercent
          temperature
          threadUrl
          status
          image {
            url
          }
          store {
            name
            displayName
          }
          category {
            name
          }
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

// Query para buscar promoções recentes
const QUERY_RECENT = `
  query GetRecentDeals($page: Int, $size: Int) {
    threads(
      filter: RECENT
      page: $page
      size: $size
    ) {
      edges {
        node {
          id
          title
          price
          nextBestPrice
          discountFixed
          discountPercent
          temperature
          threadUrl
          status
          image {
            url
          }
          store {
            name
            displayName
          }
        }
      }
    }
  }
`;

function buildAffiliateUrl(url, affiliateTag) {
  if (!url) return url;
  // Para links do ML dentro do Pelando, injeta tag de afiliado
  try {
    const u = new URL(url);
    if (u.hostname.includes('mercadolivre') || u.hostname.includes('mercadolibre')) {
      u.searchParams.set('mt', affiliateTag);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function processNode(node, affiliateTag, minDiscount) {
  try {
    if (!node || node.status !== 'ACTIVE') return null;

    const salePrice = node.price ? parseFloat(node.price) : null;
    if (!salePrice || salePrice <= 0) return null;

    const originalPrice = node.nextBestPrice ? parseFloat(node.nextBestPrice) : null;

    // Desconto em % — o Pelando já calcula isso
    let discountPercent = node.discountPercent
      ? Math.round(parseFloat(node.discountPercent))
      : null;

    // Calcula se não veio pronto
    if (!discountPercent && originalPrice && originalPrice > salePrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    if (discountPercent !== null && discountPercent < minDiscount) return null;
    if (!discountPercent) return null; // só posta se tem desconto confirmado

    const imageUrl = node.image?.url || null;
    const store = node.store?.displayName || node.store?.name || '';

    return {
      ml_id:            'PELANDO_' + node.id,
      title:            (node.title || '').substring(0, 200),
      original_price:   originalPrice,
      sale_price:       salePrice,
      discount_percent: discountPercent,
      image_url:        imageUrl,
      original_url:     node.threadUrl,
      affiliate_url:    buildAffiliateUrl(node.threadUrl, affiliateTag),
      category:         node.category?.name || store || 'geral',
      seller:           store,
      source:           'pelando',
    };
  } catch {
    return null;
  }
}

async function fetchPelando(query, variables, affiliateTag, minDiscount) {
  const resp = await axios.post(
    PELANDO_API,
    { query, variables },
    { headers: HEADERS, timeout: 15000 }
  );

  const edges = resp.data?.data?.threads?.edges || [];
  const results = [];

  for (const edge of edges) {
    const promo = processNode(edge.node, affiliateTag, minDiscount);
    if (promo) results.push(promo);
  }

  return results;
}

async function scrapePelandoHot(affiliateTag, minDiscount = 15) {
  console.log('[Pelando] Buscando promoções quentes...');
  try {
    const results = await fetchPelando(
      QUERY_HOT,
      { page: 1, size: 50 },
      affiliateTag,
      minDiscount
    );
    console.log(`[Pelando] ${results.length} promos quentes encontradas`);
    if (results.length > 0) {
      const ex = results[0];
      console.log(`[Pelando] Ex: "${ex.title.substring(0, 45)}" | R$${ex.sale_price} (era R$${ex.original_price}) | -${ex.discount_percent}%`);
    }
    return results;
  } catch (err) {
    console.error('[Pelando] Erro hot:', err.response?.data || err.message);
    return [];
  }
}

async function scrapePelandoRecent(affiliateTag, minDiscount = 15) {
  console.log('[Pelando] Buscando promoções recentes...');
  try {
    const results = await fetchPelando(
      QUERY_RECENT,
      { page: 1, size: 50 },
      affiliateTag,
      minDiscount
    );
    console.log(`[Pelando] ${results.length} promos recentes encontradas`);
    return results;
  } catch (err) {
    console.error('[Pelando] Erro recentes:', err.response?.data || err.message);
    return [];
  }
}

module.exports = { scrapePelandoHot, scrapePelandoRecent };
