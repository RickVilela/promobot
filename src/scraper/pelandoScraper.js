const axios = require('axios');
const cheerio = require('cheerio');

// Pelando usa GraphQL mas o endpoint correto é via www.pelando.com.br/graphql
// Confirmado via inspeção do tráfego do site
const PELANDO_GQL = 'https://www.pelando.com.br/graphql';

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://www.pelando.com.br',
  'Referer': 'https://www.pelando.com.br/',
};

// Query usada pelo próprio site (capturada via DevTools)
const QUERY = `
  query FeedQuery($feedType: FeedType!, $page: Int!, $pageSize: Int!, $categoryIds: [String]) {
    feed(feedType: $feedType, page: $page, pageSize: $pageSize, categoryIds: $categoryIds) {
      threads {
        id
        title
        price
        priceOld
        discount
        temperature
        status
        threadUrl: url
        imageUrl
        storeName
        commentCount
        published
      }
    }
  }
`;

function buildAffiliateUrl(url, affiliateTag) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname.includes('mercadolivre') || u.hostname.includes('mercadolibre')) {
      u.searchParams.set('mt', affiliateTag);
    }
    return u.toString();
  } catch { return url; }
}

function processThread(thread, affiliateTag, minDiscount) {
  try {
    if (!thread || thread.status !== 'ACTIVE') return null;

    const salePrice = thread.price != null ? parseFloat(thread.price) : null;
    if (!salePrice || salePrice <= 0) return null;

    const originalPrice = thread.priceOld != null ? parseFloat(thread.priceOld) : null;

    let discountPercent = thread.discount ? Math.abs(parseInt(thread.discount)) : null;
    if (!discountPercent && originalPrice && originalPrice > salePrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }
    if (!discountPercent || discountPercent < minDiscount) return null;

    return {
      ml_id:            'PELANDO_' + thread.id,
      title:            (thread.title || '').substring(0, 200),
      original_price:   originalPrice,
      sale_price:       salePrice,
      discount_percent: discountPercent,
      image_url:        thread.imageUrl || null,
      original_url:     thread.threadUrl,
      affiliate_url:    buildAffiliateUrl(thread.threadUrl, affiliateTag),
      category:         thread.storeName || 'geral',
      seller:           thread.storeName || null,
      source:           'pelando',
    };
  } catch { return null; }
}

async function fetchViaGraphQL(feedType, affiliateTag, minDiscount) {
  const resp = await axios.post(
    PELANDO_GQL,
    {
      query: QUERY,
      variables: { feedType, page: 1, pageSize: 50 },
    },
    { headers: HEADERS, timeout: 15000 }
  );

  const threads = resp.data?.data?.feed?.threads || [];
  return threads.map(t => processThread(t, affiliateTag, minDiscount)).filter(Boolean);
}

// Fallback: scraping HTML da página inicial do Pelando
async function fetchViaHtml(affiliateTag, minDiscount) {
  const resp = await axios.get('https://www.pelando.com.br/', {
    headers: {
      'User-Agent': HEADERS['User-Agent'],
      'Accept': 'text/html',
    },
    timeout: 15000,
  });

  const $ = cheerio.load(resp.data);
  const results = [];

  // Tenta extrair do __NEXT_DATA__ (Next.js injeta dados aqui)
  const nextData = $('script#__NEXT_DATA__').html();
  if (nextData) {
    try {
      const data = JSON.parse(nextData);
      // Navega pela estrutura do Next.js
      const pages = data?.props?.pageProps;
      const threads =
        pages?.initialData?.feed?.threads ||
        pages?.feed?.threads ||
        pages?.threads || [];

      for (const t of threads) {
        const p = processThread(t, affiliateTag, minDiscount);
        if (p) results.push(p);
      }

      if (results.length > 0) {
        console.log(`[Pelando] __NEXT_DATA__: ${results.length} promos`);
        return results;
      }
    } catch {}
  }

  // Fallback HTML direto
  $('[data-testid="deal-card"], [class*="DealCard"], [class*="deal-card"]').each((_, el) => {
    try {
      const $el = $(el);
      const title = $el.find('[class*="title"], h2, h3').first().text().trim();
      if (!title) return;

      const priceText = $el.find('[class*="price"], [class*="Price"]').first().text();
      const salePrice = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));
      if (!salePrice) return;

      const link = $el.find('a').first().attr('href');
      const img = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src');
      const discountText = $el.find('[class*="discount"], [class*="Discount"]').first().text();
      const discountMatch = discountText.match(/(\d+)/);
      const discountPercent = discountMatch ? parseInt(discountMatch[1]) : null;

      if (!discountPercent || discountPercent < minDiscount) return;

      const url = link ? (link.startsWith('http') ? link : 'https://www.pelando.com.br' + link) : null;
      if (!url) return;

      results.push({
        ml_id:            'PELANDO_HTML_' + Math.random().toString(36).substr(2, 9),
        title:            title.substring(0, 200),
        original_price:   null,
        sale_price:       salePrice,
        discount_percent: discountPercent,
        image_url:        img || null,
        original_url:     url,
        affiliate_url:    buildAffiliateUrl(url, affiliateTag),
        category:         'geral',
        seller:           null,
        source:           'pelando',
      });
    } catch {}
  });

  return results;
}

async function scrapePelandoHot(affiliateTag, minDiscount = 15) {
  console.log('[Pelando] Buscando promoções quentes...');

  // Tenta GraphQL primeiro
  try {
    const results = await fetchViaGraphQL('HOT', affiliateTag, minDiscount);
    if (results.length > 0) {
      console.log(`[Pelando] GraphQL: ${results.length} promos`);
      if (results[0]) {
        const ex = results[0];
        console.log(`[Pelando] Ex: "${ex.title.substring(0,45)}" | R$${ex.sale_price} | -${ex.discount_percent}%`);
      }
      return results;
    }
  } catch (err) {
    console.log('[Pelando] GraphQL falhou:', err.message, '— tentando HTML...');
  }

  // Fallback HTML
  try {
    const results = await fetchViaHtml(affiliateTag, minDiscount);
    console.log(`[Pelando] HTML: ${results.length} promos`);
    return results;
  } catch (err) {
    console.error('[Pelando] HTML também falhou:', err.message);
    return [];
  }
}

async function scrapePelandoRecent(affiliateTag, minDiscount = 15) {
  console.log('[Pelando] Buscando promoções recentes...');
  try {
    const results = await fetchViaGraphQL('RECENT', affiliateTag, minDiscount);
    console.log(`[Pelando] Recentes: ${results.length} promos`);
    return results;
  } catch (err) {
    console.error('[Pelando] Erro recentes:', err.message);
    return [];
  }
}

module.exports = { scrapePelandoHot, scrapePelandoRecent };