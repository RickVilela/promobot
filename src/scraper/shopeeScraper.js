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
  console.log('[Shopee] Buscando "Shopee Offers" (Ofertas Oficiais de Afiliados)...');
  
  // A query para "Shopee Offer" utiliza shopeeOfferV2
  const query = `query getShopeeOffers($page: Int, $limit: Int) {
    shopeeOfferV2(page: $page, limit: $limit) {
      nodes {
        itemId
        productName
        imageUrl
        offerLink
        price             # Preço atual
        originalPrice     # Preço sem desconto
        discount          # Valor do desconto (ex: "30%")
        shopName
        commissionRate    # Taxa de comissão (útil para saber se vale a pena postar)
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { page: 1, limit: 50 });
  const items = data?.shopeeOfferV2?.nodes || [];
  
  const results = [];
  for (const item of items) {
    const salePrice = parseFloat(item.price);
    const originalPrice = parseFloat(item.originalPrice || item.price);
    
    // Extração robusta do desconto
    let discountPercent = 0;
    if (item.discount) {
      discountPercent = parseInt(String(item.discount).replace(/[^0-9]/g, ''));
    }

    // Se o preço original for igual ao de venda, tentamos calcular se houver indicação de desconto
    if (originalPrice <= salePrice && discountPercent > 0) {
      const calculatedOriginal = salePrice / (1 - (discountPercent / 100));
      results.push(buildSchema(item, salePrice, calculatedOriginal, discountPercent, affiliateTag));
    } 
    // Se o desconto for válido e atingir o mínimo
    else if (discountPercent >= minDiscount || originalPrice > salePrice) {
      const finalDiscount = discountPercent || Math.round(((originalPrice - salePrice) / originalPrice) * 100);
      
      if (finalDiscount >= minDiscount) {
        results.push(buildSchema(item, salePrice, originalPrice, finalDiscount, affiliateTag));
      }
    }
  }

  console.log(`[Shopee] ${results.length} Shopee Offers encontradas.`);
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