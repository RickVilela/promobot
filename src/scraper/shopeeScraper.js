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
async function scrapeShopeeOffers(affiliateTag, minDiscount = 5) {
  const query = `query getProductList($page: Int, $limit: Int) {
    productOfferV2(page: $page, limit: $limit, sortType: 1) {
      nodes {
        itemId
        productName
        imageUrl
        offerLink
        priceMin        # Preço Atual (com desconto)
        originalPrice   # Preço de Tabela (pode vir nulo)
        discount        # % de desconto da Shopee
        shopName
        sales           # Útil para filtrar apenas o que vende muito
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { page: 1, limit: 50 });
  return processShopeeItems(data?.productOfferV2?.nodes || [], affiliateTag, minDiscount, 'Ofertas');
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
    // Se originalPrice for nulo ou igual ao salePrice, tentamos inferir pelo campo discount
    let originalPrice = parseFloat(item.originalPrice);
    let discountPercent = item.discount ? parseInt(item.discount.replace('%', '')) : 0;

    // Se a API não mandou originalPrice mas mandou discount, calculamos o reverso:
    if ((!originalPrice || originalPrice <= salePrice) && discountPercent > 0) {
      originalPrice = salePrice / (1 - (discountPercent / 100));
    }

    // Se ainda assim forem iguais, o produto não é uma "oferta" real de preço riscado
    if (!originalPrice || originalPrice <= salePrice) continue;

    // Recalcula desconto real para precisão
    const realDiscount = Math.round(((originalPrice - salePrice) / originalPrice) * 100);

    if (realDiscount >= minDiscount) {
      results.push({
        ml_id: `SHOPEE_${item.itemId}`,
        title: item.productName,
        original_price: originalPrice,
        sale_price: salePrice,
        discount_percent: realDiscount,
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