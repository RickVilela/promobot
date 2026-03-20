const axios = require('axios');
const cheerio = require('cheerio');

// ─── Rakuten Advertising API ──────────────────────────────────────
// Documentação: https://developers.rakutenadvertising.com
// Coupon Feed:  https://couponfeed.linksynergy.com/coupon
// Auth Token:   https://api.rakutenadvertising.com/v1/token
//
// Variáveis necessárias no .env / Railway:
//   RAKUTEN_WS_TOKEN      → painel: Support > APIs > Manage Tokens > Web Services Token
//   RAKUTEN_CLIENT_ID     → Developer Portal > Applications > Client ID
//   RAKUTEN_CLIENT_SECRET → Developer Portal > Applications > Client Secret
//   RAKUTEN_NETWORK_ID    → 9 (Brasil)

let _accessToken = null;
let _tokenExpiry = 0;

function getConfig() {
  return {
    wsToken:      process.env.RAKUTEN_WS_TOKEN      || null,
    clientId:     process.env.RAKUTEN_CLIENT_ID     || null,
    clientSecret: process.env.RAKUTEN_CLIENT_SECRET || null,
    networkId:    process.env.RAKUTEN_NETWORK_ID    || '9',
  };
}

function isConfigured() {
  const { wsToken } = getConfig();
  return !!wsToken;
}

// ─── Renovação automática do API Access Token ─────────────────────
// Token dura 60 min — renovamos com client_id + client_secret
async function getAccessToken() {
  const { clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) return null;

  // Usa token em cache se ainda válido (com 5 min de margem)
  if (_accessToken && Date.now() < _tokenExpiry - 300000) {
    return _accessToken;
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const resp = await axios.post(
      'https://api.rakutenadvertising.com/v1/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
    _accessToken = resp.data.access_token;
    _tokenExpiry = Date.now() + (resp.data.expires_in * 1000);
    console.log('[Rakuten] Token renovado, expira em', resp.data.expires_in, 'segundos');
    return _accessToken;
  } catch (err) {
    console.error('[Rakuten] Erro ao renovar token:', err.response?.data || err.message);
    return null;
  }
}

// ─── Coupon Feed API ──────────────────────────────────────────────
// Retorna até 500 cupons/promoções das lojas parceiras aprovadas
// Filtros: promotiontype (Sale|Coupon|Clearance|Free Shipping)
//          category, network, mid (anunciante específico)
async function fetchCouponFeed(extraParams = {}) {
  const { wsToken, networkId } = getConfig();
  if (!wsToken) {
    console.log('[Rakuten] RAKUTEN_WS_TOKEN não configurado');
    return [];
  }

  const params = new URLSearchParams({
    token:          wsToken,
    promotiontype:  'Sale|Coupon|Clearance|Liquidação|Cupom',
    resultsperpage: '500',
    pagenumber:     '1',
    ...extraParams,
  });

  const url = `https://couponfeed.linksynergy.com/coupon?${params}`;
  console.log('[Rakuten] Buscando Coupon Feed...');

  const resp = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/xml, text/xml' },
    timeout: 20000,
  });

  const $ = cheerio.load(resp.data, { xmlMode: true });
  const total = $('TotalMatches').text();
  console.log(`[Rakuten] ${total || '?'} cupons disponíveis`);

  const coupons = [];
  $('coupon').each((_, el) => {
    try {
      const $el = $(el);
      coupons.push({
        mid:          $el.find('mid').text().trim(),
        merchantName: $el.find('merchantname').text().trim(),
        title:        $el.find('offerdescription').text().trim(),
        productName:  $el.find('productname').text().trim(),
        clickUrl:     $el.find('clickurl').text().trim(),
        imageUrl:     $el.find('imageurl').text().trim() || $el.find('productimageurl').text().trim() || null,
        couponCode:   $el.find('couponcode').text().trim() || null,
        discountType: $el.find('discounttype').text().trim(),
        discount:     parseFloat($el.find('discount').text()) || null,
        salePrice:    parseFloat($el.find('saleprice').text()) || null,
        retailPrice:  parseFloat($el.find('retail').text()) || null,
        category:     $el.find('category').text().trim(),
        endDate:      $el.find('offerenddate').text().trim(),
        promoType:    $el.find('promotiontype').text().trim(),
      });
    } catch {}
  });

  return coupons;
}

// ─── Processa cupom em promoção para o bot ────────────────────────
function processCoupon(coupon, affiliateTag, minDiscount) {
  const { merchantName, title, productName, clickUrl, imageUrl,
    discountType, discount, salePrice, retailPrice, couponCode } = coupon;

  if (!clickUrl) return null;

  const displayTitle = (productName || title || merchantName || '').substring(0, 200);
  if (!displayTitle) return null;

  let sale = salePrice;
  let original = retailPrice;
  let discountPercent = null;

  if (discountType === 'Percent Off' && discount) {
    discountPercent = Math.round(discount);
    if (original && !sale) sale = Math.round(original * (1 - discount / 100) * 100) / 100;
  } else if (discountType === 'Dollar Off' && discount && original) {
    sale = Math.round((original - discount) * 100) / 100;
    discountPercent = Math.round((discount / original) * 100);
  } else if (original && sale && original > sale) {
    discountPercent = Math.round(((original - sale) / original) * 100);
  }

  if (!discountPercent || discountPercent < minDiscount) return null;

  // Adiciona tag de afiliado extra se for link do ML
  let affUrl = clickUrl;
  try {
    const u = new URL(clickUrl);
    if (u.hostname.includes('mercadolivre') || u.hostname.includes('mercadolibre')) {
      u.searchParams.set('mt', affiliateTag);
      affUrl = u.toString();
    }
  } catch {}

  return {
    ml_id:            'RAKUTEN_' + Buffer.from(clickUrl).toString('base64').substr(0, 20).replace(/[/+=]/g, ''),
    title:            displayTitle,
    original_price:   original || null,
    sale_price:       sale || null,
    discount_percent: discountPercent,
    image_url:        imageUrl || null,
    original_url:     clickUrl,
    affiliate_url:    affUrl,
    category:         coupon.category || merchantName || 'geral',
    seller:           merchantName || null,
    source:           'rakuten',
    extra_info:       couponCode ? `Cupom: ${couponCode}` : null,
  };
}

// ─── API pública ──────────────────────────────────────────────────
async function scrapeRakutenOffers(affiliateTag, minDiscount = 15) {
  if (!isConfigured()) {
    console.log('[Rakuten] Não configurado — adicione RAKUTEN_WS_TOKEN no .env/Railway');
    return [];
  }

  try {
    const coupons = await fetchCouponFeed();
    const results = coupons
      .map(c => processCoupon(c, affiliateTag, minDiscount))
      .filter(Boolean);

    console.log(`[Rakuten] ${results.length} promoções com >= ${minDiscount}% desconto`);
    if (results[0]) {
      const ex = results[0];
      console.log(`[Rakuten] Ex: "${ex.title.substring(0,45)}" | R$${ex.sale_price} (era R$${ex.original_price}) | -${ex.discount_percent}%`);
    }
    return results;
  } catch (err) {
    console.error('[Rakuten] Erro:', err.response?.data || err.message);
    return [];
  }
}

async function scrapeRakutenCategory(categoryKey, affiliateTag, minDiscount = 15) {
  if (!isConfigured()) return [];
  try {
    const coupons = await fetchCouponFeed({ category: categoryKey });
    return coupons.map(c => processCoupon(c, affiliateTag, minDiscount)).filter(Boolean);
  } catch (err) {
    console.error(`[Rakuten] Erro categoria ${categoryKey}:`, err.message);
    return [];
  }
}

module.exports = { scrapeRakutenOffers, scrapeRakutenCategory, isConfigured };
