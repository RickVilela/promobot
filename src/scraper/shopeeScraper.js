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
  if (!appId || !secret) return null;

  const bodyPayload = JSON.stringify({ query, variables });
  const headers = generateShopeeAuth(appId, secret, bodyPayload);

  try {
    const response = await axios.post('https://open-api.affiliate.shopee.com.br/graphql', bodyPayload, { headers, timeout: 15000 });
    return response.data?.data;
  } catch (err) {
    console.error('[Shopee] Erro na rede:', err.message);
    return null;
  }
}

async function scrapeShopeeOffers(affiliateTag, minDiscount = 10) {
  console.log('[Shopee] Buscando Ofertas do Dia (Maiores Comissões/Descontos)...');
  
  // Query otimizada para a lista geral de ofertas (V2)
  const query = `query getProductList($page: Int, $limit: Int) {
    productOfferV2(page: $page, limit: $limit, sortType: 2) {
      nodes {
        itemId
        productName
        imageUrl
        offerLink
        priceMin
        originalPrice
        discount
        shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { page: 1, limit: 50 });
  const items = data?.productOfferV2?.nodes || [];
  
  const results = [];
  for (const item of items) {
    const salePrice = parseFloat(item.priceMin);
    let originalPrice = parseFloat(item.originalPrice);
    
    // Extrai o número do desconto (ex: "25%" -> 25)
    let discountPercent = item.discount ? parseInt(String(item.discount).replace(/[^0-9]/g, '')) : 0;

    // Se a API não mandou originalPrice mas mandou %, calculamos o valor "DE"
    if ((!originalPrice || originalPrice <= salePrice) && discountPercent > 0) {
      originalPrice = salePrice / (1 - (discountPercent / 100));
    } 
    // Se mandou originalPrice mas não mandou %, calculamos a %
    else if (originalPrice > salePrice && discountPercent === 0) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    // Só aceita se houver um desconto real identificado
    if (discountPercent >= minDiscount && salePrice > 0) {
      results.push({
        ml_id: `SHOPEE_${item.itemId}`,
        title: item.productName,
        original_price: originalPrice > salePrice ? originalPrice : null,
        sale_price: salePrice,
        discount_percent: discountPercent,
        image_url: item.imageUrl,
        original_url: item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        category: 'Ofertas do Dia',
        seller: item.shopName,
        source: 'shopee'
      });
    }
  }

  console.log(`[Shopee] ${results.length} promoções filtradas.`);
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

module.exports = { scrapeShopeeOffers };