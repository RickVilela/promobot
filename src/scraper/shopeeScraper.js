const axios = require('axios');
const crypto = require('crypto');

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

// 🔥 PROMOÇÕES
async function scrapeShopeeOffers(affiliateTag, minDiscount = 15) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret) return [];

  console.log('[Shopee] Buscando promoções...');

  const results = [];

  try {
    const body = {
      query: `
      {
        productOfferV2(listType: 1, sortType: 2, page: 1, limit: 50) {
          nodes {
            itemId
            productName
            offerLink
            imageUrl
            priceMin
            priceMax
            shopName
          }
        }
      }`
    };

    const headers = getShopeeHeaders(appId, secret, body);

    const resp = await axios.post(
      'https://open-api.affiliate.shopee.com.br/graphql',
      body,
      { headers }
    );

    const items = resp.data?.data?.productOfferV2?.nodes || [];

    console.log(`[Shopee] ${items.length} itens recebidos`);

    for (const item of items) {
      const price = parseFloat(item.priceMin || item.priceMax);
      if (!price) continue;

      results.push({
        ml_id: 'SHOPEE_' + item.itemId,
        title: item.productName,
        sale_price: price,
        image_url: item.imageUrl,
        original_url: item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        seller: item.shopName,
        source: 'shopee',
      });
    }

  } catch (err) {
    console.error('[Shopee] Erro:', err.response?.data || err.message);
  }

  return results;
}

// 🔍 KEYWORD
async function scrapeShopeeKeyword(keyword, affiliateTag) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret) return [];

  console.log(`[Shopee] Buscando: ${keyword}`);

  const results = [];

  try {
    const body = {
      query: `
      {
        productOfferV2(keyword: "${keyword}", page: 1, limit: 30) {
          nodes {
            itemId
            productName
            offerLink
            imageUrl
            priceMin
            priceMax
            shopName
          }
        }
      }`
    };

    const headers = getShopeeHeaders(appId, secret, body);

    const resp = await axios.post(
      'https://open-api.affiliate.shopee.com.br/graphql',
      body,
      { headers }
    );

    const items = resp.data?.data?.productOfferV2?.nodes || [];

    for (const item of items) {
      const price = parseFloat(item.priceMin || item.priceMax);
      if (!price) continue;

      results.push({
        ml_id: 'SHOPEE_' + item.itemId,
        title: item.productName,
        sale_price: price,
        image_url: item.imageUrl,
        original_url: item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        seller: item.shopName,
        source: 'shopee',
      });
    }

  } catch (err) {
    console.error('[Shopee] Erro keyword:', err.response?.data || err.message);
  }

  return results;
}

module.exports = {
  scrapeShopeeOffers,
  scrapeShopeeKeyword,
};