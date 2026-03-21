const axios = require('axios');

// ─── W-API — API WhatsApp Brasileira ─────────────────────────────
// Documentação: https://painel.w-api.app/developer
// Postman:      https://www.postman.com/w-api/w-api-api-do-whatsapp
//
// Como configurar:
// 1. Crie sua conta em painel.w-api.app
// 2. Crie uma instância e escaneie o QR code com seu WhatsApp
// 3. Copie o Instance ID e o Token da instância
// 4. Para grupos: abra o grupo no WhatsApp Web, copie o ID da URL
//    (formato: 5511999999999-1234567890@g.us)
//
// Variáveis no Railway:
//   WAPI_INSTANCE_ID  → ID da sua instância (ex: 1234567890)
//   WAPI_TOKEN        → Token Bearer da instância
//   WAPI_CHANNELS     → Números/IDs separados por vírgula
//                       Número: 5511999999999
//                       Grupo:  5511999999999-1234567890@g.us
//                       Canal:  5511999999999@newsletter

function isConfigured() {
  return !!(process.env.WAPI_INSTANCE_ID && process.env.WAPI_TOKEN);
}

function getChannels() {
  return (process.env.WAPI_CHANNELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getHeaders() {
  return {
    'Authorization': 'Bearer ' + process.env.WAPI_TOKEN,
    'Content-Type': 'application/json',
  };
}

function getBaseUrl() {
  return `https://api.w-api.app/v1`;
}

// Formata número para o padrão W-API
// Aceita: 11999999999, 5511999999999, ou IDs de grupo/canal
function formatPhone(phone) {
  const p = String(phone).trim();
  // Já é ID de grupo ou canal
  if (p.includes('@')) return p;
  // Remove caracteres não numéricos
  const digits = p.replace(/\D/g, '');
  // Adiciona 55 se não tiver
  if (digits.length === 11) return '55' + digits;
  if (digits.length === 10) return '55' + digits;
  return digits;
}

function formatPrice(value) {
  if (!value || value === 0) return null;
  return 'R$ ' + value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildMessage(promo) {
  const discount = promo.discount_percent;
  const seller = promo.seller || 'loja parceira';

  let fire = '🔥';
  if (discount >= 50) fire = '🚨🔥';
  else if (discount >= 30) fire = '💥';

  let msg = fire + ' *' + promo.title + '*\n\n';

  if (promo.original_price && promo.sale_price && promo.sale_price > 0) {
    msg += '💰 De: ~' + formatPrice(promo.original_price) + '~\n';
    msg += '🏷 Por: *' + formatPrice(promo.sale_price) + '*';
    if (discount) msg += '  ✅ *-' + discount + '% OFF*';
    msg += '\n\n';
  } else if (discount) {
    msg += '✅ *' + discount + '% de desconto!*\n\n';
  }

  if (promo.extra_info) {
    msg += '🎟 *' + promo.extra_info + '*\n\n';
  }

  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += '🛒 *Comprar na ' + seller + ':*\n' + promo.affiliate_url + '\n\n';
  msg += '_⏳ Oferta por tempo limitado!_';

  return msg;
}

// Envia mensagem de texto
async function sendText(phone, message) {
  const instanceId = process.env.WAPI_INSTANCE_ID;
  const url = `${getBaseUrl()}/message/send-text?instanceId=${instanceId}`;

  const resp = await axios.post(url, {
    phone: formatPhone(phone),
    message,
  }, { headers: getHeaders(), timeout: 15000 });

  return resp.data;
}

// Envia imagem com legenda
async function sendImage(phone, imageUrl, caption) {
  const instanceId = process.env.WAPI_INSTANCE_ID;
  const url = `${getBaseUrl()}/message/send-image?instanceId=${instanceId}`;

  const resp = await axios.post(url, {
    phone:        formatPhone(phone),
    image:        imageUrl,
    caption:      caption,
    delayMessage: 1,
  }, { headers: getHeaders(), timeout: 15000 });

  return resp.data;
}

async function sendPromotion(promo) {
  if (!isConfigured()) {
    return { success: false, reason: 'W-API não configurada — adicione WAPI_INSTANCE_ID e WAPI_TOKEN' };
  }

  const channels = getChannels();
  if (!channels.length) {
    return { success: false, reason: 'Nenhum canal WhatsApp configurado — adicione WAPI_CHANNELS' };
  }

  const message = buildMessage(promo);
  const results = [];

  for (const channel of channels) {
    try {
      if (promo.image_url) {
        try {
          await sendImage(channel, promo.image_url, message);
          console.log(`[WhatsApp] ✓ Imagem postada em ${channel}: ${promo.title.substring(0, 40)}`);
          results.push({ channel, success: true, type: 'image' });
        } catch (imgErr) {
          const imgErrMsg = imgErr.response?.data?.message || imgErr.response?.data?.error || imgErr.message;
          console.error(`[WhatsApp] Erro ao enviar imagem em ${channel}:`, imgErrMsg, '| image_url:', promo.image_url?.substring(0, 60));
          // Fallback para texto
          await sendText(channel, message);
          console.log(`[WhatsApp] ✓ Fallback texto em ${channel}`);
          results.push({ channel, success: true, type: 'text_fallback', imageError: imgErrMsg });
        }
      } else {
        await sendText(channel, message);
        console.log(`[WhatsApp] ✓ Texto postado em ${channel}: ${promo.title.substring(0, 40)}`);
        results.push({ channel, success: true, type: 'text' });
      }

      await new Promise(r => setTimeout(r, 1500)); // delay entre canais
    } catch (err) {
      const errMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      console.error(`[WhatsApp] Erro em ${channel}:`, errMsg);
      results.push({ channel, success: false, error: errMsg });
    }
  }

  return { success: results.some(r => r.success), results };
}

async function testConnection() {
  if (!isConfigured()) {
    return { ok: false, error: 'WAPI_INSTANCE_ID ou WAPI_TOKEN não configurados' };
  }

  try {
    const instanceId = process.env.WAPI_INSTANCE_ID;
    const resp = await axios.get(
      `${getBaseUrl()}/instance/status-instance?instanceId=${instanceId}`,
      { headers: getHeaders(), timeout: 8000 }
    );
    return { ok: true, instance: resp.data };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

module.exports = { sendPromotion, testConnection, isConfigured, buildMessage };