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
    
    if (response.data?.errors) {
      console.error('[Shopee] Erro GraphQL:', response.data.errors[0].message);
      return null;
    }
    return response.data?.data;
  } catch (err) {
    console.error('[Shopee] Erro na rede:', err.message);
    return null;
  }
}

async function scrapeShopeeOffers(affiliateTag, minDiscount = 5) {
  console.log('[Shopee] Buscando "Shopee Offers" (Ofertas Oficiais)...');
  
  /**
   * QUERY CORRIGIDA: 
   * No endpoint ShopeeOfferV2, os dados detalhados do item 
   * ficam dentro do objeto 'productInfo'.
   */
  const query = `query getShopeeOffers($page: Int, $limit: Int) {
    shopeeOfferV2(page: $page, limit: $limit) {
      nodes {
        productInfo {
          itemId
          productName
          imageUrl
          offerLink
          price
          originalPrice
          discount
          shopName
        }
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { page: 1, limit: 50 });
  const nodes = data?.shopeeOfferV2?.nodes || [];
  
  const results = [];
  for (const node of nodes) {
    // Extraímos o produto do sub-objeto 'productInfo'
    const item = node.productInfo;
    if (!item) continue;

    const salePrice = parseFloat(item.price);
    let originalPrice = parseFloat(item.originalPrice || 0);
    
    // Extração do desconto (ex: "30%" -> 30)
    let discountPercent = item.discount ? parseInt(String(item.discount).replace(/[^0-9]/g, '')) : 0;

    // Lógica de recuperação de preço original
    if ((!originalPrice || originalPrice <= salePrice) && discountPercent > 0) {
      originalPrice = salePrice / (1 - (discountPercent / 100));
    }

    // Filtro de desconto mínimo
    if (discountPercent >= minDiscount && salePrice > 0) {
      results.push({
        ml_id: `SHOPEE_OFFER_${item.itemId}`,
        title: item.productName,
        original_price: originalPrice > salePrice ? originalPrice : null,
        sale_price: salePrice,
        discount_percent: discountPercent,
        image_url: item.imageUrl,
        original_url: item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        category: 'Shopee Offers',
        seller: item.shopName,
        source: 'shopee'
      });
    }
  }

  console.log(`[Shopee] ${results.length} Shopee Offers processadas.`);
  return results;
}

// Helper para manter o objeto padronizado
function buildSchema(item, sale, original, discount, tag) {
  return {
    ml_id: `SHOPEE_${item.itemId}`,
    title: item.productName,
    original_price: original > sale ? original : null,
    sale_price: sale,
    discount_percent: discount,
    image_url: item.imageUrl,
    original_url: item.offerLink,
    affiliate_url: buildAffiliateUrl(item.offerLink, tag),
    category: 'Shopee Offers',
    seller: item.shopName,
    source: 'shopee'
  };
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