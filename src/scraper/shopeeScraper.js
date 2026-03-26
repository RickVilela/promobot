const axios = require('axios');
const crypto = require('crypto');

/**
 * Gera a assinatura SHA256 conforme exigido pela Shopee.
 * O segredo aqui é que o 'payload' deve ser a string exata do body da requisição.
 */
function generateShopeeAuth(appId, secret, bodyString) {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = appId + timestamp + bodyString + secret;
  const signature = crypto.createHash('sha256').update(baseString).digest('hex');

  return {
    'Content-Type': 'application/json',
    'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
  };
}

async function fetchShopeeGraphQL(query, variables = {}) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret || appId === 'seu_shopee_app_id') {
    console.error('[Shopee] Erro: Credenciais não configuradas no ENV.');
    return null;
  }

  // Importante: O body deve ser transformado em string uma única vez para garantir consistência
  const bodyPayload = JSON.stringify({ query, variables });
  const headers = generateShopeeAuth(appId, secret, bodyPayload);

  try {
    const response = await axios.post(
      'https://open-api.affiliate.shopee.com.br/graphql',
      bodyPayload,
      { headers, timeout: 15000 }
    );

    // Logs de depuração
    if (response.data.errors) {
      console.error('[Shopee] Erro na Query GraphQL:', JSON.stringify(response.data.errors, null, 2));
      return null;
    }

    return response.data.data;
  } catch (error) {
    console.error('[Shopee] Erro na requisição HTTP:', error.response?.data || error.message);
    return null;
  }
}

async function scrapeShopeeOffers(affiliateTag, minDiscount = 15) {
  console.log('[Shopee] Iniciando busca de ofertas...');

  // Query simplificada para evitar campos que podem vir nulos e quebrar o processamento
  const query = `query getProductList($page: Int, $limit: Int) {
    productOfferV2(page: $page, limit: $limit, sortType: 2) {
      nodes {
        itemId
        productName
        imageUrl
        offerLink
        originalPrice
        priceMin
        priceMax
        discount
        shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { page: 1, limit: 50 });
  const items = data?.productOfferV2?.nodes || [];

  return processShopeeItems(items, affiliateTag, minDiscount, 'shopee_geral');
}

async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 15) {
  console.log(`[Shopee] Buscando por termo: "${keyword}"`);

  const query = `query getProductByKeyword($keyword: String, $page: Int, $limit: Int) {
    productOfferV2(keyword: $keyword, page: $page, limit: $limit) {
      nodes {
        itemId
        productName
        imageUrl
        offerLink
        originalPrice
        priceMin
        priceMax
        discount
        shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { keyword, page: 1, limit: 30 });
  const items = data?.productOfferV2?.nodes || [];

  return processShopeeItems(items, affiliateTag, minDiscount, keyword);
}

/**
 * Função auxiliar para processar e filtrar os resultados
 */
function processShopeeItems(items, affiliateTag, minDiscount, categoryName) {
  const results = [];
  
  for (const item of items) {
    const salePrice = parseFloat(item.priceMin || item.priceMax);
    const originalPrice = parseFloat(item.originalPrice);
    
    if (!salePrice) continue;

    let discountPercent = item.discount ? parseInt(item.discount) : 0;
    if (discountPercent === 0 && originalPrice > salePrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    if (discountPercent < minDiscount) continue;

    results.push({
      ml_id: `SHOPEE_${item.itemId}`,
      title: item.productName?.substring(0, 200),
      original_price: originalPrice || salePrice,
      sale_price: salePrice,
      discount_percent: discountPercent,
      image_url: item.imageUrl,
      affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
      category: categoryName,
      seller: item.shopName,
      source: 'shopee'
    });
  }

  console.log(`[Shopee] Filtro concluído: ${results.length} produtos encontrados.`);
  return results;
}

function buildAffiliateUrl(url, subId) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (subId) u.searchParams.set('sub_id', subId);
    return u.toString();
  } catch {
    return url;
  }
}

module.exports = { scrapeShopeeOffers, scrapeShopeeKeyword };