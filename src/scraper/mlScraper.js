const axios = require('axios');
const cheerio = require('cheerio');

// Mapeamento de categorias ML
const ML_CATEGORIES = {
  eletronicos: 'MLB1000',
  informatica: 'MLB1648',
  eletrodomesticos: 'MLB1574',
  moda: 'MLB1430',
  esportes: 'MLB1276',
  casa: 'MLB1459',
  celulares: 'MLB1051',
  games: 'MLB1144',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

function buildAffiliateUrl(originalUrl, affiliateTag) {
  try {
    const url = new URL(originalUrl);
    // Remove parâmetros desnecessários
    url.searchParams.delete('pdp_filters');
    // Adiciona tag de afiliado ML
    url.searchParams.set('mt', affiliateTag);
    return url.toString();
  } catch {
    return originalUrl + (originalUrl.includes('?') ? '&' : '?') + `mt=${affiliateTag}`;
  }
}

function extractMlId(url) {
  const match = url.match(/MLB-?(\d+)/i);
  return match ? `MLB${match[1]}` : null;
}

function parsePrice(text) {
  if (!text) return null;
  const clean = text.replace(/[^\d,]/g, '').replace(',', '.');
  const val = parseFloat(clean);
  return isNaN(val) ? null : val;
}

function calcDiscount(original, sale) {
  if (!original || !sale || original <= sale) return null;
  return Math.round(((original - sale) / original) * 100);
}

// Busca ofertas do dia no ML
async function scrapeOffersOfDay(affiliateTag, minDiscount = 15) {
  const results = [];

  try {
    console.log('[Scraper] Buscando ofertas do dia no Mercado Livre...');

    const response = await axios.get('https://www.mercadolivre.com.br/ofertas', {
      headers: HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const items = [];

    // Seletores para a página de ofertas
    $('li.promotion-item, .andes-card.poly-card, [class*="promotion-item"]').each((i, el) => {
      items.push(el);
    });

    // Fallback: busca por estrutura genérica de produto
    if (items.length === 0) {
      $('[class*="item"], [class*="product"]').each((i, el) => {
        if ($(el).find('a[href*="mercadolivre"]').length > 0) {
          items.push(el);
        }
      });
    }

    console.log(`[Scraper] Encontrados ${items.length} itens para processar`);

    for (const el of items.slice(0, 50)) {
      try {
        const $el = $(el);

        const link = $el.find('a[href*="mercadolivre.com.br"]').first().attr('href') ||
                     $el.closest('a').attr('href');

        if (!link) continue;

        const cleanLink = link.split('#')[0].split('?')[0];
        const mlId = extractMlId(cleanLink);
        if (!mlId) continue;

        const title = $el.find('[class*="title"], h2, h3').first().text().trim() ||
                      $el.attr('title') || '';
        if (!title || title.length < 5) continue;

        const salePriceText = $el.find('[class*="price__fraction"], [class*="sale-price"], .price-tag-fraction').first().text();
        const salePrice = parsePrice(salePriceText);
        if (!salePrice) continue;

        const originalPriceText = $el.find('[class*="original-price"], [class*="crossed"], s').first().text();
        const originalPrice = parsePrice(originalPriceText);

        const discount = calcDiscount(originalPrice, salePrice);

        // Filtra por desconto mínimo
        if (discount !== null && discount < minDiscount) continue;

        const imageUrl = $el.find('img').first().attr('src') ||
                         $el.find('img').first().attr('data-src') || '';

        results.push({
          ml_id: mlId,
          title: title.substring(0, 200),
          original_price: originalPrice,
          sale_price: salePrice,
          discount_percent: discount,
          image_url: imageUrl.startsWith('http') ? imageUrl : null,
          original_url: cleanLink,
          affiliate_url: buildAffiliateUrl(cleanLink, affiliateTag),
          category: 'geral',
          seller: null,
        });
      } catch (err) {
        // Ignora item com erro
      }
    }
  } catch (err) {
    console.error('[Scraper] Erro ao buscar ofertas:', err.message);
  }

  return results;
}

// Busca por palavra-chave
async function scrapeByKeyword(keyword, affiliateTag, minDiscount = 15) {
  const results = [];

  try {
    const query = encodeURIComponent(keyword);
    const url = `https://www.mercadolivre.com.br/busca?q=${query}&sort=price_asc`;

    console.log(`[Scraper] Buscando: "${keyword}"...`);

    const response = await axios.get(url, {
      headers: HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);

    $('.ui-search-result, [class*="search-result"], .poly-card').each((i, el) => {
      if (i > 20) return false;
      try {
        const $el = $(el);

        const link = $el.find('a.ui-search-link, a[href*="mercadolivre"]').first().attr('href');
        if (!link) return;

        const cleanLink = link.split('#')[0];
        const mlId = extractMlId(cleanLink);
        if (!mlId) return;

        const title = $el.find('.ui-search-item__title, [class*="title"]').first().text().trim();
        if (!title) return;

        const salePriceText = $el.find('.andes-money-amount__fraction, [class*="price__fraction"]').first().text();
        const salePrice = parsePrice(salePriceText);
        if (!salePrice) return;

        const originalPriceText = $el.find('.ui-search-price__original-value, [class*="original"]').text();
        const originalPrice = parsePrice(originalPriceText);
        const discount = calcDiscount(originalPrice, salePrice);

        if (discount !== null && discount < minDiscount) return;

        const imageUrl = $el.find('img.ui-search-result-image__element, img[data-src]').first().attr('data-src') ||
                         $el.find('img').first().attr('src') || '';

        results.push({
          ml_id: mlId,
          title: title.substring(0, 200),
          original_price: originalPrice,
          sale_price: salePrice,
          discount_percent: discount,
          image_url: imageUrl.startsWith('http') ? imageUrl : null,
          original_url: cleanLink,
          affiliate_url: buildAffiliateUrl(cleanLink, affiliateTag),
          category: keyword,
          seller: null,
        });
      } catch {}
    });
  } catch (err) {
    console.error(`[Scraper] Erro ao buscar "${keyword}":`, err.message);
  }

  return results;
}

// Busca por categoria
async function scrapeByCategory(categoryKey, affiliateTag, minDiscount = 15) {
  const categoryId = ML_CATEGORIES[categoryKey];
  if (!categoryId) return [];

  const results = [];

  try {
    const url = `https://www.mercadolivre.com.br/ofertas?category=${categoryId}`;
    console.log(`[Scraper] Buscando categoria: ${categoryKey}...`);

    const response = await axios.get(url, {
      headers: HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);

    $('li.promotion-item, .andes-card, [class*="promotion-item"]').each((i, el) => {
      if (i > 30) return false;
      try {
        const $el = $(el);
        const link = $el.find('a').first().attr('href');
        if (!link || !link.includes('mercadolivre')) return;

        const cleanLink = link.split('#')[0].split('?')[0];
        const mlId = extractMlId(cleanLink);
        if (!mlId) return;

        const title = $el.find('[class*="title"]').first().text().trim();
        if (!title) return;

        const salePriceText = $el.find('[class*="fraction"]').first().text();
        const salePrice = parsePrice(salePriceText);
        if (!salePrice) return;

        const originalPriceText = $el.find('[class*="original"], s').first().text();
        const originalPrice = parsePrice(originalPriceText);
        const discount = calcDiscount(originalPrice, salePrice);

        if (discount !== null && discount < minDiscount) return;

        const imageUrl = $el.find('img').first().attr('src') || '';

        results.push({
          ml_id: mlId,
          title: title.substring(0, 200),
          original_price: originalPrice,
          sale_price: salePrice,
          discount_percent: discount,
          image_url: imageUrl.startsWith('http') ? imageUrl : null,
          original_url: cleanLink,
          affiliate_url: buildAffiliateUrl(cleanLink, affiliateTag),
          category: categoryKey,
          seller: null,
        });
      } catch {}
    });
  } catch (err) {
    console.error(`[Scraper] Erro na categoria ${categoryKey}:`, err.message);
  }

  return results;
}

module.exports = { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory, buildAffiliateUrl };
