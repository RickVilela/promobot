const axios = require('axios');
const crypto = require('crypto');

// ─────────────────────────────────────────────
// 🔐 AUTH
// ─────────────────────────────────────────────
function getShopeeHeaders(appId, secret, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(body);

  const signature = crypto
    .createHash('sha256')
    .update(appId + timestamp + payload + secret)
    .digest('hex');

  return {
    'Content-Type': 'application/json',
    Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
  };
}

function buildAffiliateUrl(url, subId) {
  try {
    const u = new URL(url);
    if (subId) u.searchParams.set('sub_id', subId);
    return u.toString();
  } catch {
    return url;
  }
}

// ─────────────────────────────────────────────
// 🔥 PROMOÇÕES
// ─────────────────────────────────────────────
async function scrapeShopeeOffers(affiliateTag, minDiscount = 15) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret) {
    console.log('[Shopee] Sem credenciais');
    return [];
  }

  console.log('[Shopee] Buscando promoções...');
  const results = [];

  try {
    const body = {
      query: `
      query {
        productOfferV2(listType: 2, sortType: 2, page: 1, limit: 50) {
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
      }`,
    };

    const headers = getShopeeHeaders(appId, secret, body);

    const resp = await axios.post(
      'https://affiliate-open-api.shopee.com.br/graphql',
      body,
      { headers, timeout: 15000 }
    );

    const items = resp.data?.data?.productOfferV2?.nodes || [];
    console.log(`[Shopee] ${items.length} itens recebidos`);

    for (const item of items) {
      const salePrice = parseFloat(item.priceMin || item.priceMax);
      const originalPrice = parseFloat(item.originalPrice);

      if (!salePrice) continue;

      let discount = item.discount
        ? parseInt(item.discount)
        : originalPrice
        ? Math.round(((originalPrice - salePrice) / originalPrice) * 100)
        : null;

      if (discount !== null && discount < minDiscount) continue;

      results.push({
        ml_id: 'SHOPEE_' + item.itemId,
        title: item.productName,
        original_price: originalPrice,
        sale_price: salePrice,
        discount_percent: discount,
        image_url: item.imageUrl,
        original_url: item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        category: 'shopee',
        seller: item.shopName,
        source: 'shopee',
      });
    }
  } catch (err) {
    console.error('[Shopee] Erro:', err.response?.data || err.message);
  }

  console.log(`[Shopee] ${results.length} promoções válidas`);
  return results;
}

// ─────────────────────────────────────────────
// 🔍 KEYWORD
// ─────────────────────────────────────────────
async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 15) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret) return [];

  console.log(`[Shopee] Buscando: "${keyword}"`);

  const results = [];

  try {
    const body = {
      query: `
      query {
        productOfferV2(keyword: "${keyword}", page: 1, limit: 30) {
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
      }`,
    };

    const headers = getShopeeHeaders(appId, secret, body);

    const resp = await axios.post(
      'https://affiliate-open-api.shopee.com.br/graphql',
      body,
      { headers, timeout: 15000 }
    );

    const items = resp.data?.data?.productOfferV2?.nodes || [];

    for (const item of items) {
      const salePrice = parseFloat(item.priceMin || item.priceMax);
      const originalPrice = parseFloat(item.originalPrice);

      if (!salePrice) continue;

      let discount = item.discount
        ? parseInt(item.discount)
        : originalPrice
        ? Math.round(((originalPrice - salePrice) / originalPrice) * 100)
        : null;

      if (discount !== null && discount < minDiscount) continue;

      results.push({
        ml_id: 'SHOPEE_' + item.itemId,
        title: item.productName,
        original_price: originalPrice,
        sale_price: salePrice,
        discount_percent: discount,
        image_url: item.imageUrl,
        original_url: item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        category: keyword,
        seller: item.shopName,
        source: 'shopee',
      });
    }
  } catch (err) {
    console.error(`[Shopee] Erro keyword "${keyword}":`, err.response?.data || err.message);
  }

  return results;
}

module.exports = {
  scrapeShopeeOffers,
  scrapeShopeeKeyword,
};