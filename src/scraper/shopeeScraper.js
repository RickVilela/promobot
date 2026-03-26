const axios = require('axios');
const crypto = require('crypto');

// ─── Shopee Affiliate API (REST) ───────────────────────────────

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

// ───────────────────────────────────────────────────────────────
// 🔥 BUSCAR PROMOÇÕES GERAIS
// ───────────────────────────────────────────────────────────────
async function scrapeShopeeOffers(affiliateTag, minDiscount = 15) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret) {
    console.log('[Shopee] Credenciais não configuradas');
    return [];
  }

  const results = [];
  console.log('[Shopee] Buscando promoções...');

  try {
    const body = {
      page: 1,
      limit: 50,
      sort_type: 2, // 1 = popularidade | 2 = comissão
    };

    const headers = getShopeeHeaders(appId, secret, body);

    const resp = await axios.post(
      'https://open-api.affiliate.shopee.com.br/api/v1/product_offer/list',
      body,
      { headers, timeout: 15000 }
    );

    const items = resp.data?.data?.list || [];
    console.log(`[Shopee] ${items.length} itens recebidos`);

    for (const item of items) {
      try {
        const originalPrice = parseFloat(item.price_before_discount) || null;
        const salePrice = parseFloat(item.price) || null;
        if (!salePrice) continue;

        let discountPercent = item.discount_rate || null;

        if (!discountPercent && originalPrice && originalPrice > salePrice) {
          discountPercent = Math.round(
            ((originalPrice - salePrice) / originalPrice) * 100
          );
        }

        if (discountPercent !== null && discountPercent < minDiscount) continue;

        results.push({
          ml_id: 'SHOPEE_' + item.item_id,
          title: (item.item_name || '').substring(0, 200),
          original_price: originalPrice,
          sale_price: salePrice,
          discount_percent: discountPercent,
          image_url: item.image || null,
          original_url: item.product_link,
          affiliate_url: buildAffiliateUrl(item.product_link, affiliateTag),
          category: 'shopee',
          seller: item.shop_name || null,
          source: 'shopee',
        });
      } catch (e) {}
    }
  } catch (err) {
    console.error('[Shopee] Erro:', err.response?.data || err.message);
  }

  console.log(`[Shopee] ${results.length} promoções válidas`);
  return results;
}

// ───────────────────────────────────────────────────────────────
// 🔍 BUSCAR POR PALAVRA-CHAVE
// ───────────────────────────────────────────────────────────────
async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 15) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret) return [];

  console.log(`[Shopee] Buscando keyword: "${keyword}"`);

  const results = [];

  try {
    const body = {
      keyword: keyword,
      page: 1,
      limit: 30,
    };

    const headers = getShopeeHeaders(appId, secret, body);

    const resp = await axios.post(
      'https://open-api.affiliate.shopee.com.br/api/v1/product_offer/list',
      body,
      { headers, timeout: 15000 }
    );

    const items = resp.data?.data?.list || [];

    for (const item of items) {
      try {
        const originalPrice = parseFloat(item.price_before_discount) || null;
        const salePrice = parseFloat(item.price) || null;
        if (!salePrice) continue;

        let discountPercent = item.discount_rate || null;

        if (!discountPercent && originalPrice && originalPrice > salePrice) {
          discountPercent = Math.round(
            ((originalPrice - salePrice) / originalPrice) * 100
          );
        }

        if (discountPercent !== null && discountPercent < minDiscount) continue;

        results.push({
          ml_id: 'SHOPEE_' + item.item_id,
          title: (item.item_name || '').substring(0, 200),
          original_price: originalPrice,
          sale_price: salePrice,
          discount_percent: discountPercent,
          image_url: item.image || null,
          original_url: item.product_link,
          affiliate_url: buildAffiliateUrl(item.product_link, affiliateTag),
          category: keyword,
          seller: item.shop_name || null,
          source: 'shopee',
        });
      } catch (e) {}
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