const axios = require('axios');
const cheerio = require('cheerio');

// ─── Rakuten Advertising (ex-LinkShare) ──────────────────────────
// Documentação: https://developers.rakutenadvertising.com
//
// APIs usadas:
// 1. Coupon Feed  → couponfeed.linksynergy.com/coupon
//    Retorna promoções/cupons de todas as lojas parceiras
//    Requer: Web Services Token (painel → Links → Web Services)
//
// 2. Deep Links   → developers.rakutenadvertising.com/api/deeplinkgenerator
//    Converte URL de produto em link de afiliado rastreável
//    Requer: API Access Token (painel → Developer Portal)
//
// Lojas BR na Rakuten: Americanas, Submarino, Shoptime, Extra,
//   Casas Bahia, Pontofrio, Netshoes, Centauro, Renner e outras
//
// Como obter tokens:
//   Web Services Token: publisher.rakutenadvertising.com → Links → Web Services
//   API Access Token:   developers.rakutenadvertising.com → Applications

// Categorias Rakuten para filtrar (IDs da rede)
const RAKUTEN_CATEGORIES = {
  electronics:    '7',
  clothing:       '2',
  home:           '8',
  sports:         '26',
  computers:      '5',
  health:         '14',
  toys:           '27',
  jewelry:        '11',
};

function getTokens() {
  return {
    wsToken:    process.env.RAKUTEN_WS_TOKEN   || null,  // Web Services Token
    apiToken:   process.env.RAKUTEN_API_TOKEN  || null,  // API Access Token
    siteId:     process.env.RAKUTEN_SITE_ID    || null,  // seu Site ID (publisher ID)
    networkId:  process.env.RAKUTEN_NETWORK_ID || '9',   // 9 = Brasil
  };
}

function isConfigured() {
  const { wsToken } = getTokens();
  return !!wsToken && wsToken !== 'seu_rakuten_ws_token';
}

// ─── 1. Coupon Feed — promoções e cupons ativos ───────────────────
// GET couponfeed.linksynergy.com/coupon?token=TOKEN&network=9&...
// Retorna XML com: offerdescription, offerbegindate, offerenddate,
//   clickurl (link afiliado), saleprice, retail (preço original),
//   discounttype, discount, merchantname, category
async function fetchCouponFeed(params = {}) {
  const { wsToken, networkId } = getTokens();
  if (!wsToken) return [];

  const qs = new URLSearchParams({
    token:          wsToken,
    network:        networkId,
    resultsperpage: '500',
    pagenumber:     '1',
    ...params,
  });

  const url = `https://couponfeed.linksynergy.com/coupon?${qs}`;
  console.log('[Rakuten] Buscando Coupon Feed...');

  const resp = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/xml' },
    timeout: 20000,
  });

  const $ = cheerio.load(resp.data, { xmlMode: true });
  const coupons = [];

  $('coupon').each((_, el) => {
    try {
      const $el = $(el);
      coupons.push({
        merchantName:    $el.find('merchantname').text().trim(),
        merchantId:      $el.find('mid').text().trim(),
        offerTitle:      $el.find('offerdescription').text().trim(),
        clickUrl:        $el.find('clickurl').text().trim(),
        salePrice:       parseFloat($el.find('saleprice').text()) || null,
        retailPrice:     parseFloat($el.find('retail').text()) || null,
        discount:        parseFloat($el.find('discount').text()) || null,
        discountType:    $el.find('discounttype').text().trim(),
        category:        $el.find('category').text().trim(),
        couponCode:      $el.find('couponcode').text().trim(),
        promotionType:   $el.find('promotiontype').text().trim(),
        offerEndDate:    $el.find('offerenddate').text().trim(),
        imageUrl:        $el.find('imageurl, productimageurl').text().trim() || null,
        productName:     $el.find('productname').text().trim(),
      });
    } catch {}
  });

  console.log(`[Rakuten] ${coupons.length} cupons/promoções retornados`);
  return coupons;
}

// ─── 2. Deep Link — converte URL em link de afiliado ─────────────
// POST /api/deeplinkgenerator
// Requer API Access Token
async function generateDeepLink(targetUrl, siteId) {
  const { apiToken } = getTokens();
  if (!apiToken || !siteId) return targetUrl; // retorna URL original se sem token

  try {
    const resp = await axios.get(
      'https://api.rakutenadvertising.com/v2/deep-links',
      {
        params: { url: targetUrl, sid: siteId },
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Accept': 'application/json',
        },
        timeout: 8000,
      }
    );
    return resp.data?.deep_link || targetUrl;
  } catch {
    return targetUrl; // fallback para URL original
  }
}

// ─── Processamento de cupons em promoções ────────────────────────
function processCopon(coupon, affiliateTag, minDiscount) {
  const { merchantName, offerTitle, clickUrl, salePrice, retailPrice,
    discount, discountType, imageUrl, productName } = coupon;

  if (!clickUrl) return null;

  // Título: usa productName se disponível, senão offerTitle
  const title = (productName || offerTitle || merchantName || '').substring(0, 200);
  if (!title) return null;

  // Cálculo de desconto
  let discountPercent = null;
  let sale = salePrice;
  let original = retailPrice;

  if (discountType === 'Percent Off' && discount) {
    discountPercent = Math.round(discount);
    if (original && !sale) sale = original * (1 - discount / 100);
  } else if (discountType === 'Dollar Off' && discount && original) {
    sale = original - discount;
    discountPercent = Math.round((discount / original) * 100);
  } else if (original && sale && original > sale) {
    discountPercent = Math.round(((original - sale) / original) * 100);
  }

  if (discountPercent !== null && discountPercent < minDiscount) return null;
  if (!discountPercent) return null;

  // Adiciona tag de afiliado extra na URL se for ML
  let affUrl = clickUrl;
  try {
    const u = new URL(clickUrl);
    if (u.hostname.includes('mercadolivre') || u.hostname.includes('mercadolibre')) {
      u.searchParams.set('mt', affiliateTag);
      affUrl = u.toString();
    }
  } catch {}

  return {
    ml_id:            'RAKUTEN_' + Buffer.from(clickUrl).toString('base64').substr(0, 16).replace(/[/+=]/g, ''),
    title,
    original_price:   original || null,
    sale_price:       sale || null,
    discount_percent: discountPercent,
    image_url:        imageUrl || null,
    original_url:     clickUrl,
    affiliate_url:    affUrl,
    category:         coupon.category || merchantName || 'geral',
    seller:           merchantName || null,
    source:           'rakuten',
  };
}

// ─── API pública ─────────────────────────────────────────────────
async function scrapeRakutenOffers(affiliateTag, minDiscount = 15) {
  if (!isConfigured()) {
    console.log('[Rakuten] Não configurado — adicione RAKUTEN_WS_TOKEN no .env');
    return [];
  }

  try {
    // Busca promoções sem filtro de categoria (pega tudo da rede BR)
    const coupons = await fetchCouponFeed({
      promotiontype: 'Coupon|Sale|Clearance|Free Shipping',
    });

    const results = [];
    for (const coupon of coupons) {
      const promo = processCopon(coupon, affiliateTag, minDiscount);
      if (promo) results.push(promo);
    }

    console.log(`[Rakuten] ${results.length} promoções com >= ${minDiscount}% desconto`);
    if (results[0]) {
      const ex = results[0];
      console.log(`[Rakuten] Ex: "${ex.title.substring(0,45)}" | R$${ex.sale_price} | -${ex.discount_percent}%`);
    }
    return results;

  } catch (err) {
    console.error('[Rakuten] Erro:', err.response?.data || err.message);
    return [];
  }
}

async function scrapeRakutenCategory(categoryKey, affiliateTag, minDiscount = 15) {
  if (!isConfigured()) return [];
  const catId = RAKUTEN_CATEGORIES[categoryKey];
  if (!catId) return [];

  try {
    const coupons = await fetchCouponFeed({ category: catId });
    return coupons
      .map(c => processCopon(c, affiliateTag, minDiscount))
      .filter(Boolean);
  } catch (err) {
    console.error(`[Rakuten] Erro categoria ${categoryKey}:`, err.message);
    return [];
  }
}

module.exports = {
  scrapeRakutenOffers,
  scrapeRakutenCategory,
  generateDeepLink,
  isConfigured,
};
