const axios = require('axios');
const crypto = require('crypto');

/**
 * Gera a assinatura SHA256 exigida pela Shopee Open API.
 * O segredo é assinar a string exata do JSON que será enviado.
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

/**
 * Faz a chamada GraphQL genérica para a Shopee.
 */
async function fetchShopeeGraphQL(query, variables = {}) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret || appId === 'seu_app_id') {
    console.error('[Shopee] Erro: Credenciais não configuradas no .env');
    return null;
  }

  const bodyPayload = JSON.stringify({ query, variables });
  const headers = generateShopeeAuth(appId, secret, bodyPayload);

  try {
    const response = await axios.post(
      'https://open-api.affiliate.shopee.com.br/graphql',
      bodyPayload,
      { headers, timeout: 15000 }
    );

    if (response.data?.errors) {
      console.error('[Shopee] Erro GraphQL:', JSON.stringify(response.data.errors[0].message));
      return null;
    }

    return response.data?.data;
  } catch (error) {
    console.error('[Shopee] Erro na requisição HTTP:', error.message);
    return null;
  }
}

/**
 * Função principal para buscar ofertas gerais (usando um termo padrão).
 */
async function scrapeShopeeOffers(affiliateTag, minDiscount = 5) {
  // A Shopee v2 exige um keyword ou categoria para retornar nodes.
  // Usamos "oferta" ou "promocao" para filtrar itens com preço reduzido.
  return scrapeShopeeKeyword("oferta", affiliateTag, minDiscount);
}

/**
 * Busca produtos por palavra-chave específica.
 */
async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 5) {
  console.log(`[Shopee] Buscando: "${keyword}" (Min Desc: ${minDiscount}%)`);

  const query = `query getProductOffers($keyword: String, $page: Int, $limit: Int) {
    productOfferV2(
      keyword: $keyword,
      listType: 1, 
      sortType: 5, 
      page: $page, 
      limit: $limit
    ) {
      nodes {
        itemId
        productName
        productLink
        offerLink
        imageUrl
        priceMin
        priceMax
        priceDiscountRate
        shopName
      }
      pageInfo {
        page
        limit
        hasNextPage
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { keyword, page: 1, limit: 50 });
  const items = data?.productOfferV2?.nodes || [];
  
  const results = [];
  for (const item of items) {
    const salePrice = parseFloat(item.priceMin || 0);
    const maxPrice = parseFloat(item.priceMax || 0);
    
    // 1. Pega o desconto vindo da API
    let discountPercent = item.priceDiscountRate 
      ? parseInt(String(item.priceDiscountRate).replace(/[^0-9]/g, '')) 
      : 0;

    // 2. Lógica de Contingência: Se a API mandou desconto 0, mas o preço Max > Min, 
    // calculamos o desconto real baseado na variação.
    let originalPrice = (maxPrice > salePrice) ? maxPrice : null;
    
    if (discountPercent === 0 && originalPrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    // 3. Se ainda assim não temos preço original, mas temos a %, calculamos o valor "DE"
    if (discountPercent > 0 && !originalPrice) {
      originalPrice = salePrice / (1 - (discountPercent / 100));
    }

    // Filtro final de segurança
    if (salePrice > 0 && discountPercent >= minDiscount) {
      results.push({
        ml_id: `SHOPEE_${item.itemId}`,
        title: item.productName,
        original_price: originalPrice > salePrice ? originalPrice : null,
        sale_price: salePrice,
        discount_percent: discountPercent,
        image_url: item.imageUrl,
        original_url: item.productLink || item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        category: keyword,
        seller: item.shopName,
        source: 'shopee'
      });
    }
  }

  console.log(`[Shopee] ${results.length} produtos filtrados encontrados.`);
  return results;
}

/**
 * Adiciona o sub_id (tag de afiliado) à URL da Shopee.
 */
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

module.exports = { 
  scrapeShopeeOffers, 
  scrapeShopeeKeyword 
};