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
const TERMOS_GENERICOS = [
  "casa e cozinha", "eletronicos", "eletroportateis", 
  "tecnologia", "utilidades domesticas", "smart home",
  "gadgets", "informatica", "iluminação led"
];

async function scrapeShopeeOffers(affiliateTag, minDiscount = 10) {
  // Escolhe um termo genérico aleatório para cada ciclo
  const termoAleatorio = TERMOS_GENERICOS[Math.floor(Math.random() * TERMOS_GENERICOS.length)];
  console.log(`[Shopee] Ciclo de Variedade: Buscando por "${termoAleatorio}"`);
  
  return scrapeShopeeKeyword(termoAleatorio, affiliateTag, minDiscount);
}

async function scrapeShopeeKeyword(keyword, affiliateTag, minDiscount = 5) {
  const query = `query getProductOffers($keyword: String, $page: Int, $limit: Int) {
    productOfferV2(
      keyword: $keyword,
      listType: 0, 
      sortType: 2, 
      page: $page, 
      limit: $limit
    ) {
      nodes {
        itemId
        productName
        productLink
        offerLink
        imageUrl
        priceMin            # Preço com desconto
        priceMax            # Preço original (riscado)
        priceDiscountRate   # Porcentagem de desconto
        shopName
      }
    }
  }`;

  const data = await fetchShopeeGraphQL(query, { keyword, page: 1, limit: 40 });
  const items = data?.productOfferV2?.nodes || [];
  
  const results = [];
  const seenIds = new Set();

  for (const item of items) {
    if (seenIds.has(item.itemId)) continue;

    // CAPTURA LITERAL DOS CAMPOS
    const sale_price = parseFloat(item.priceMin);
    const original_price = parseFloat(item.priceMax);
    const discount_percent = item.priceDiscountRate ? parseInt(String(item.priceDiscountRate).replace(/[^0-9]/g, '')) : 0;

    // REGRA DE OURO: Ignora se algum campo essencial for nulo, zero ou se não houver desconto real
    if (!sale_price || !original_price || !discount_percent) continue;
    
    // Ignora se o preço original não for maior que o de venda (evita erro de exibição)
    if (original_price <= sale_price) continue;

    // Filtro de desconto mínimo solicitado por você
    if (discount_percent < minDiscount) continue;

    seenIds.add(item.itemId);
    results.push({
      ml_id: `SH_${item.itemId}`,
      title: item.productName.substring(0, 100),
      original_price: original_price,
      sale_price: sale_price,
      discount_percent: discount_percent,
      image_url: item.imageUrl,
      original_url: item.productLink || item.offerLink,
      affiliate_url: buildAffiliateUrl(item.offerLink, affiliateTag),
      category: 'Destaques',
      seller: item.shopName,
      source: 'shopee'
    });
  }

  return results.sort(() => 0.5 - Math.random());
}

/**
 * Limpa títulos poluídos (remove excesso de emojis e termos de busca)
 */
function cleanTitle(title) {
  return title
    .replace(/[✨🔥✅⭐🚚]/g, '') // Remove emojis comuns de spam
    .split(' - ')[0]             // Pega apenas a primeira parte do título
    .substring(0, 80)            // Limita tamanho
    .trim();
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