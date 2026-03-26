const axios = require('axios');
const crypto = require('crypto');

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
  
  // Garantimos que o JSON não tenha espaços extras para não invalidar a assinatura
  const bodyPayload = JSON.stringify({ query, variables });
  const headers = generateShopeeAuth(appId, secret, bodyPayload);

  try {
    const response = await axios.post(
      'https://open-api.affiliate.shopee.com.br/graphql',
      bodyPayload,
      { headers, timeout: 15000 }
    );

    if (response.data.errors) {
      console.error('[Shopee] Erro GraphQL:', JSON.stringify(response.data.errors));
      return null;
    }
    return response.data.data;
  } catch (error) {
    console.error('[Shopee] Erro HTTP:', error.response?.data || error.message);
    return null;
  }
}

async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 15) {
  console.log(`[Shopee] Buscando: "${keyword}"`);

  // QUERY ATUALIZADA: Removidos campos 'discount' e 'originalPrice' que causam erro
  const query = `query getProductByKeyword($keyword: String, $page: Int, $limit: Int) {
    productOfferV2(keyword: $keyword, page: $page, limit: $limit) {
      nodes {
        itemId
        productName
        imageUrl
        offerLink
        price      
        priceMin
        priceMax
        shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { keyword, page: 1, limit: 30 });
  const items = data?.productOfferV2?.nodes || [];

  const results = items.map(item => {
    const salePrice = parseFloat(item.price || item.priceMin || item.priceMax);
    
    return {
      ml_id: `SHOPEE_${item.itemId}`,
      title: item.productName,
      original_price: salePrice, // A API não está mais enviando o preço "De" nesta query
      sale_price: salePrice,
      discount_percent: 0, // Como o campo discount sumiu, setamos 0 para não filtrar
      image_url: item.imageUrl,
      affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
      category: keyword,
      seller: item.shopName,
      source: 'shopee'
    };
  });

  console.log(`[Shopee] ${results.length} produtos encontrados para "${keyword}"`);
  return results;
}

function buildAffiliateUrl(url, subId) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (subId) u.searchParams.set('sub_id', subId);
    return u.toString();
  } catch { return url; }
}

module.exports = { scrapeShopeeKeyword };