const axios = require('axios');
const crypto = require('crypto');

// ─── Shopee Affiliate API ───────────────────────────────────────
// Docs: https://open-api.affiliate.shopee.com.br
// Cadastro: https://affiliate.shopee.com.br

function getShopeeHeaders(appId, secret, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(body);
  // SHA256 puro (nao HMAC): appId + timestamp + payload + secret
  const signature = crypto.createHash('sha256').update(appId + timestamp + payload + secret).digest('hex');
  return {
    'Content-Type': 'application/json',
    'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
  };
}

function buildAffiliateUrl(url, subId) {
  // Shopee usa subId para rastreamento
  try {
    const u = new URL(url);
    if (subId) u.searchParams.set('sub_id', subId);
    return u.toString();
  } catch {
    return url;
  }
}

async function scrapeShopeeOffers(affiliateTag, minDiscount = 15) {
  const appId  = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret || appId === 'seu_shopee_app_id') {
    console.log('[Shopee] Credenciais não configuradas, pulando...');
    return [];
  }

  const results = [];
  console.log('[Shopee] Buscando promoções...');

  try {
    // Endpoint de produtos em oferta
    const body = {
      page: 1,
      limit: 50,
      sortType: 2, // 2 = por comissão, 1 = por popularidade
    };

    const headers = getShopeeHeaders(appId, secret, body);
    const resp = await axios.post(
      'https://open-api.affiliate.shopee.com.br/graphql',
      {
        query: `{
          productOfferV2(listType: 0, sortType: 2, page: 1, limit: 50) {
            nodes {
              itemId
              productName
              imageUrl
              offerLink
              originalPrice
              priceMin
              priceMax
              discount
              commission
              sales
              shopName
            }
          }
        }`
      },
      { headers, timeout: 15000 }
    );

    const items = resp.data?.data?.productOfferV2?.nodes || [];
    console.log(`[Shopee] ${items.length} itens recebidos`);

    for (const item of items) {
      try {
        const originalPrice = parseFloat(item.originalPrice) || null;
        const salePrice     = parseFloat(item.priceMin || item.priceMax) || null;
        if (!salePrice) continue;

        let discountPercent = item.discount ? parseInt(item.discount) : null;
        if (!discountPercent && originalPrice && originalPrice > salePrice) {
          discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
        }

        if (discountPercent !== null && discountPercent < minDiscount) continue;

        results.push({
          ml_id:            'SHOPEE_' + item.itemId,
          title:            (item.productName || '').substring(0, 200),
          original_price:   originalPrice,
          sale_price:       salePrice,
          discount_percent: discountPercent,
          image_url:        item.imageUrl || null,
          original_url:     item.offerLink,
          affiliate_url:    buildAffiliateUrl(item.offerLink, affiliateTag),
          category:         'shopee',
          seller:           item.shopName || null,
          source:           'shopee',
        });
      } catch {}
    }
  } catch (err) {
    console.error('[Shopee] Erro:', err.response?.data || err.message);
  }

  console.log(`[Shopee] ${results.length} promoções com desconto >= ${minDiscount}%`);
  return results;
}

async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 15) {
  const appId  = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret || appId === 'seu_shopee_app_id') return [];

  console.log(`[Shopee] Buscando: "${keyword}"`);
  const results = [];

  try {
    const body = { keyword, page: 1, limit: 30 };
    const headers = getShopeeHeaders(appId, secret, body);

    const resp = await axios.post(
      'https://open-api.affiliate.shopee.com.br/graphql',
      {
        query: `{
          productOfferV2(keyword: "${keyword}", page: 1, limit: 30) {
            nodes {
              itemId productName imageUrl offerLink
              originalPrice priceMin priceMax discount shopName
            }
          }
        }`
      },
      { headers, timeout: 15000 }
    );

    const items = resp.data?.data?.productOfferV2?.nodes || [];
    for (const item of items) {
      try {
        const salePrice     = parseFloat(item.priceMin || item.priceMax) || null;
        const originalPrice = parseFloat(item.originalPrice) || null;
        if (!salePrice) continue;

        let discountPercent = item.discount ? parseInt(item.discount) : null;
        if (!discountPercent && originalPrice && originalPrice > salePrice) {
          discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
        }
        if (discountPercent !== null && discountPercent < minDiscount) continue;

        results.push({
          ml_id:            'SHOPEE_' + item.itemId,
          title:            (item.productName || '').substring(0, 200),
          original_price:   originalPrice,
          sale_price:       salePrice,
          discount_percent: discountPercent,
          image_url:        item.imageUrl || null,
          original_url:     item.offerLink,
          affiliate_url:    buildAffiliateUrl(item.offerLink, affiliateTag),
          category:         keyword,
          seller:           item.shopName || null,
          source:           'shopee',
        });
      } catch {}
    }
  } catch (err) {
    console.error(`[Shopee] Erro keyword "${keyword}":`, err.message);
  }

  return results;
}

module.exports = { scrapeShopeeOffers, scrapeShopeeKeyword };