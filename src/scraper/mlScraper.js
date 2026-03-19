const axios = require('axios');
const cheerio = require('cheerio');

const ML_CATEGORIES = {
  eletronicos:      'MLB1000',
  informatica:      'MLB1648',
  eletrodomesticos: 'MLB1574',
  moda:             'MLB1430',
  esportes:         'MLB1276',
  casa:             'MLB1459',
  celulares:        'MLB1051',
  games:            'MLB1144',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildAffiliateUrl(url, tag) {
  try {
    const u = new URL(url);
    u.searchParams.set('mt', tag);
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + 'mt=' + tag;
  }
}

function parsePrice(text) {
  if (!text) return null;
  // Remove tudo que não é dígito e vírgula/ponto
  const clean = text.replace(/[^\d.,]/g, '').trim();
  if (!clean) return null;
  // Formato BR: 1.299,90 → 1299.90
  const normalized = clean.replace(/\./g, '').replace(',', '.');
  const val = parseFloat(normalized);
  return isNaN(val) || val <= 0 ? null : val;
}

function extractMlId(url) {
  const m = url.match(/MLB-?(\d+)/i);
  return m ? 'MLB' + m[1] : null;
}

// Extrai JSON embutido na página do ML (fonte mais confiável)
function extractJsonData($) {
  const items = [];
  try {
    // O ML injeta os dados de busca num script JSON
    $('script').each((_, el) => {
      const text = $(el).html() || '';
      if (!text.includes('"original_price"') && !text.includes('"price"')) return;
      
      // Tenta extrair array de resultados
      const match = text.match(/"results"\s*:\s*(\[[\s\S]{100,}\])\s*,\s*"paging"/);
      if (match) {
        try {
          const results = JSON.parse(match[1]);
          if (Array.isArray(results) && results.length > 0) {
            items.push(...results);
          }
        } catch {}
      }
    });
  } catch {}
  return items;
}

// Extrai produtos do HTML via cheerio (fallback)
function extractFromHtml($, affiliateTag, minDiscount) {
  const results = [];

  // Seletores que o ML usa (podem variar por versão)
  const cardSelectors = [
    '.ui-search-result',
    '.andes-card',
    '[class*="poly-card"]',
    '[data-item-id]',
  ];

  let cards = $([]);
  for (const sel of cardSelectors) {
    const found = $(sel);
    if (found.length > 0) { cards = found; break; }
  }

  cards.each((_, el) => {
    try {
      const $el = $(el);

      // Link e ID
      const link = $el.find('a[href*="mercadolivre.com.br"]').first().attr('href')
                || $el.find('a[href*="produto.mercadolivre"]').first().attr('href');
      if (!link) return;

      const cleanUrl = link.split('#')[0].split('?')[0];
      const mlId = extractMlId(cleanUrl);
      if (!mlId) return;

      // Título
      const title = (
        $el.find('.poly-component__title, .ui-search-item__title, [class*="title"]').first().text()
        || $el.attr('title')
        || ''
      ).trim();
      if (!title || title.length < 5) return;

      // Preço de venda (valor atual)
      const salePriceRaw =
        $el.find('.andes-money-amount__fraction, .price-tag-fraction, [class*="price__fraction"]').first().text()
        + ($el.find('.andes-money-amount__cents, [class*="price__cents"]').first().text() || '');
      const salePrice = parsePrice(salePriceRaw);
      if (!salePrice || salePrice < 10) return;

      // Preço original (riscado)
      const originalPriceEl = $el.find(
        's .andes-money-amount__fraction, ' +
        '[class*="original"] .andes-money-amount__fraction, ' +
        '.ui-search-price__original-value .andes-money-amount__fraction, ' +
        '[class*="price--original"] .andes-money-amount__fraction, ' +
        '.poly-price__original .andes-money-amount__fraction'
      ).first();
      const originalPrice = parsePrice(originalPriceEl.text());

      // Desconto explícito no badge
      const discountBadge = $el.find('[class*="discount"], [class*="pill--discount"], .poly-price__discount').first().text();
      const discountMatch = discountBadge.match(/(\d+)\s*%/);
      let discountPercent = discountMatch ? parseInt(discountMatch[1]) : null;

      // Calcula desconto se tiver preço original
      if (!discountPercent && originalPrice && originalPrice > salePrice) {
        discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
      }

      // Filtra por desconto mínimo
      if (discountPercent !== null && discountPercent < minDiscount) return;

      // Imagem
      const img = $el.find('img[src*="http"], img[data-src*="http"]').first();
      const imageUrl = (img.attr('data-src') || img.attr('src') || '').replace('-I.jpg', '-O.jpg') || null;

      results.push({
        ml_id: mlId,
        title: title.substring(0, 200),
        original_price: originalPrice,
        sale_price: salePrice,
        discount_percent: discountPercent,
        image_url: imageUrl && imageUrl.startsWith('http') ? imageUrl : null,
        original_url: cleanUrl,
        affiliate_url: buildAffiliateUrl(cleanUrl, affiliateTag),
        category: 'geral',
        seller: null,
      });
    } catch {}
  });

  return results;
}

async function scrapeUrl(url, affiliateTag, minDiscount) {
  try {
    const resp = await axios.get(url, {
      headers: HEADERS,
      timeout: 20000,
      maxRedirects: 5,
    });

    const $ = cheerio.load(resp.data);

    // Tenta extrair do JSON embutido primeiro (mais confiável para original_price)
    const jsonItems = extractJsonData($);
    if (jsonItems.length > 0) {
      console.log(`[Scraper] JSON embutido: ${jsonItems.length} itens`);
      const results = [];
      for (const item of jsonItems) {
        try {
          if (!item.price) continue;

          // ML às vezes retorna sale em centavos (359990) e original em reais (3599)
          // Detecta pela razão entre os dois valores
          let salePrice     = item.price;
          let originalPrice = item.original_price || null;

          if (originalPrice && salePrice > originalPrice * 10) {
            salePrice = Math.round(salePrice / 100 * 100) / 100;
          } else if (!originalPrice && salePrice > 100000) {
            salePrice = Math.round(salePrice / 100 * 100) / 100;
          }

          if (originalPrice && originalPrice > 100000) {
            originalPrice = Math.round(originalPrice / 100 * 100) / 100;
          }

          let discountPercent = null;
          if (originalPrice && originalPrice > salePrice) {
            discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
          }
          if (discountPercent !== null && discountPercent < minDiscount) continue;

          const imageUrl = (item.thumbnail || '').replace('-I.jpg', '-O.jpg');

          results.push({
            ml_id:            item.id,
            title:            (item.title || '').substring(0, 200),
            original_price:   originalPrice,
            sale_price:       salePrice,
            discount_percent: discountPercent,
            image_url:        imageUrl || null,
            original_url:     item.permalink,
            affiliate_url:    buildAffiliateUrl(item.permalink, affiliateTag),
            category:         item.category_id || 'geral',
            seller:           item.seller?.nickname || null,
          });
        } catch {}
      }
      if (results.length > 0) {
        // Log do primeiro para debug
        const ex = results[0];
        console.log(`[Scraper] Ex: "${ex.title.substring(0,40)}" | sale: ${ex.sale_price} | orig: ${ex.original_price} | desc: ${ex.discount_percent}%`);
        return results;
      }
    }

    // Fallback: parse HTML
    console.log('[Scraper] Usando parser HTML...');
    const results = extractFromHtml($, affiliateTag, minDiscount);
    console.log(`[Scraper] HTML parser: ${results.length} itens com desconto`);
    if (results.length > 0) {
      const ex = results[0];
      console.log(`[Scraper] Ex: "${ex.title.substring(0,40)}" | sale: ${ex.sale_price} | orig: ${ex.original_price} | desc: ${ex.discount_percent}%`);
    }
    return results;

  } catch (err) {
    console.error('[Scraper] Erro ao buscar', url, ':', err.message);
    return [];
  }
}

async function scrapeOffersOfDay(affiliateTag, minDiscount = 15) {
  console.log('[Scraper] Buscando ofertas do dia...');
  const all = [];

  const urls = [
    'https://www.mercadolivre.com.br/ofertas',
    'https://www.mercadolivre.com.br/ofertas#nav-header',
  ];

  for (const url of urls) {
    const r = await scrapeUrl(url, affiliateTag, minDiscount);
    all.push(...r);
    if (r.length > 0) break; // se achou, não precisa tentar a segunda
    await delay(2000);
  }

  console.log(`[Scraper] Ofertas do dia: ${all.length} com desconto`);
  return dedupe(all);
}

async function scrapeByKeyword(keyword, affiliateTag, minDiscount = 15) {
  console.log(`[Scraper] Buscando: "${keyword}"`);
  const url = `https://www.mercadolivre.com.br/busca?q=${encodeURIComponent(keyword)}&sort=relevance`;
  const r = await scrapeUrl(url, affiliateTag, minDiscount);
  console.log(`[Scraper] "${keyword}": ${r.length} com desconto`);
  return r;
}

async function scrapeByCategory(categoryKey, affiliateTag, minDiscount = 15) {
  const catId = ML_CATEGORIES[categoryKey];
  if (!catId) return [];
  console.log(`[Scraper] Categoria: ${categoryKey}`);
  const url = `https://www.mercadolivre.com.br/ofertas?category=${catId}`;
  const r = await scrapeUrl(url, affiliateTag, minDiscount);
  console.log(`[Scraper] Categoria "${categoryKey}": ${r.length} com desconto`);
  return r;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(r => {
    if (seen.has(r.ml_id)) return false;
    seen.add(r.ml_id);
    return true;
  });
}

module.exports = { scrapeOffersOfDay, scrapeByKeyword, scrapeByCategory, buildAffiliateUrl };
