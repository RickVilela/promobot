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
    if (response.data.errors) return null;
    return response.data.data;
  } catch (err) { return null; }
}

// ESTA É A FUNÇÃO QUE ESTAVA FALTANDO
async function scrapeShopeeOffers(affiliateTag, minDiscount = 0) {
  console.log('[Shopee] Buscando ofertas gerais...');
  const query = `query getProductList($page: Int, $limit: Int) {
    productOfferV2(page: $page, limit: $limit, sortType: 2) {
      nodes {
        itemId
        productName
        imageUrl
        offerLink
        priceMin      # Preço com desconto (venda)
        originalPrice # Preço sem desconto (de)
        discount      # Porcentagem de desconto
        shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { page: 1, limit: 50 });
  const items = data?.productOfferV2?.nodes || [];
  return processShopeeItems(items, affiliateTag, minDiscount, 'shopee_ofertas');
}

async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 0) {
  console.log(`[Shopee] Buscando keyword: ${keyword}`);
  const query = `query getProductByKeyword($keyword: String, $page: Int, $limit: Int) {
    productOfferV2(keyword: $keyword, page: $page, limit: $limit) {
      nodes {
        itemId productName imageUrl offerLink price priceMin priceMax shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { keyword, page: 1, limit: 30 });
  const items = data?.productOfferV2?.nodes || [];
  return processShopeeItems(items, affiliateTag, minDiscount, keyword);
}

function processShopeeItems(items, affiliateTag, minDiscount, category) {
  const results = [];

  for (const item of items) {
    const salePrice = parseFloat(item.priceMin);
    const originalPrice = parseFloat(item.originalPrice || item.priceMin);
    
    // Calcula o desconto real se a API não mandar pronto
    let discountPercent = item.discount ? parseInt(item.discount) : 0;
    if (discountPercent === 0 && originalPrice > salePrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    // REGRA DE OURO: Só adiciona se houver desconto real e atingir o mínimo
    if (salePrice < originalPrice && discountPercent >= minDiscount) {
      results.push({
        ml_id: `SHOPEE_${item.itemId}`,
        title: item.productName,
        original_price: originalPrice,
        sale_price: salePrice,
        discount_percent: discountPercent,
        image_url: item.imageUrl,
        original_url: item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        category: category,
        seller: item.shopName,
        source: 'shopee'
      });
    }
  }

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

// IMPORTANTE: Exportar ambas as funções
module.exports = { scrapeShopeeOffers, scrapeShopeeKeyword };