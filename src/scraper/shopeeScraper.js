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
  console.log('[Shopee] Buscando Produtos em Oferta (productOfferV2)...');
  
  // Query baseada no schema que você enviou
  const query = `query getProductOffers($page: Int, $limit: Int) {
    productOfferV2(
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
        sales
        shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { page: 1, limit: 50 });
  const items = data?.productOfferV2?.nodes || [];
  
  const results = [];
  for (const item of items) {
    const salePrice = parseFloat(item.priceMin || 0);
    
    // O priceDiscountRate costuma vir como número (ex: 15) ou string (ex: "15%")
    let discountPercent = 0;
    if (item.priceDiscountRate) {
      discountPercent = parseInt(String(item.priceDiscountRate).replace(/[^0-9]/g, ''));
    }

    // Cálculo do preço original (Preço "De") baseado no desconto informado
    let originalPrice = null;
    if (discountPercent > 0 && salePrice > 0) {
      originalPrice = salePrice / (1 - (discountPercent / 100));
    }

    // Filtro: Só aceita se houver desconto mínimo e preço válido
    if (salePrice > 0 && discountPercent >= minDiscount) {
      results.push({
        ml_id: `SHOPEE_${item.itemId}`,
        title: item.productName,
        original_price: originalPrice,
        sale_price: salePrice,
        discount_percent: discountPercent,
        image_url: item.imageUrl,
        original_url: item.productLink || item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        category: 'Ofertas Shopee',
        seller: item.shopName,
        source: 'shopee'
      });
    }
  }

  console.log(`[Shopee] ${results.length} produtos processados.`);
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