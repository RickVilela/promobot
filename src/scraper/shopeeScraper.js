const axios = require('axios');
const crypto = require('crypto');

/**
 * Gera a assinatura SHA256 exigida pela Shopee Open API.
 * O segredo é assinar a string exata do JSON que será enviado.
 */
function generateShopeeAuth(appId, secret, bodyString) {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = appId + timestamp + bodyString + secret;
  const signature = crypto.createHash('sha256').update(baseString).digest('hex');

  return {
    'Content-Type': 'application/json',
    'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
  };
}

/**
 * Faz a chamada GraphQL genérica para a Shopee.
 */
async function fetchShopeeGraphQL(query, variables = {}) {
  const appId = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;

  if (!appId || !secret || appId === 'seu_app_id') {
    console.error('[Shopee] Erro: Credenciais não configuradas no .env');
    return null;
  }

  const bodyPayload = JSON.stringify({ query, variables });
  const headers = generateShopeeAuth(appId, secret, bodyPayload);

  try {
    const response = await axios.post(
      'https://open-api.affiliate.shopee.com.br/graphql',
      bodyPayload,
      { headers, timeout: 15000 }
    );

    if (response.data?.errors) {
      console.error('[Shopee] Erro GraphQL:', JSON.stringify(response.data.errors[0].message));
      return null;
    }

    return response.data?.data;
  } catch (error) {
    console.error('[Shopee] Erro na requisição HTTP:', error.message);
    return null;
  }
}

/**
 * Função principal para buscar ofertas gerais (usando um termo padrão).
 */
/**
 * Lista de termos focados em Casa e Eletrônicos
 */
const CATEGORIAS_RELEVANTES = [
  "smartphone xiaomi", "iphone", "smart tv", "notebook", 
  "fritadeira air fryer", "aspirador robo", "alexa echo dot",
  "caixa de som bluetooth", "monitor gamer", "cafeteira expresso"
];

async function scrapeShopeeOffers(affiliateTag, minDiscount = 10) {
  console.log('[Shopee] Iniciando busca por nichos relevantes (Casa e Eletrônicos)...');
  
  let allResults = [];
  
  // Sorteia 3 termos da lista para buscar a cada ciclo (para variar o conteúdo)
  const termosParaBuscar = CATEGORIAS_RELEVANTES
    .sort(() => 0.5 - Math.random())
    .slice(0, 3);

  for (const termo of termosParaBuscar) {
    const produtos = await scrapeShopeeKeyword(termo, affiliateTag, minDiscount);
    allResults = allResults.concat(produtos);
  }

  // Remove duplicados pelo itemId
  const uniqueResults = Array.from(new Map(allResults.map(item => [item.ml_id, item])).values());

  console.log(`[Shopee] Ciclo finalizado com ${uniqueResults.length} produtos de alta relevância.`);
  return uniqueResults;
}

async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 5) {
  console.log(`[Shopee] Filtrando: "${keyword}"`);

  const query = `query getProductOffers($keyword: String, $page: Int, $limit: Int) {
    productOfferV2(
      keyword: $keyword,
      listType: 1, 
      sortType: 1,  # Mudado para 1 (Popularidade/Vendas) para evitar produtos estranhos
      page: $page, 
      limit: $limit
    ) {
      nodes {
        itemId
        productName
        productLink
        offerLink
        imageUrl
        priceMin
        priceMax
        priceDiscountRate
        shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { keyword, page: 1, limit: 20 });
  const items = data?.productOfferV2?.nodes || [];
  
  const results = [];
  for (const item of items) {
    const salePrice = parseFloat(item.priceMin || 0);
    
    // REGRA DE QUALIDADE: Ignora produtos menores que R$ 20,00 
    // Isso remove capinhas de celular, cabos de R$ 2 e tranqueiras.
    if (salePrice < 20.00) continue;

    let discountPercent = item.priceDiscountRate ? parseInt(String(item.priceDiscountRate).replace(/[^0-9]/g, '')) : 0;
    let originalPrice = parseFloat(item.priceMax) > salePrice ? parseFloat(item.priceMax) : null;

    if (discountPercent === 0 && originalPrice) {
      discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
    }

    if (salePrice > 0 && discountPercent >= minDiscount) {
      results.push({
        ml_id: `SHOPEE_${item.itemId}`,
        title: item.productName,
        original_price: originalPrice,
        sale_price: salePrice,
        discount_percent: discountPercent,
        image_url: item.imageUrl,
        original_url: item.productLink || item.offerLink,
        affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
        category: keyword,
        seller: item.shopName,
        source: 'shopee'
      });
    }
  }
  return results;
}

/**
 * Adiciona o sub_id (tag de afiliado) à URL da Shopee.
 */
function buildAffiliateUrl(url, subId) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (subId) u.searchParams.set('sub_id', subId);
    return u.toString();
  } catch {
    return url;
  }
}

module.exports = { 
  scrapeShopeeOffers, 
  scrapeShopeeKeyword 
};