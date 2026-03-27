const TelegramBot = require('node-telegram-bot-api');
const { getChannels, savePost } = require('../db/database');

let bot = null;

function getBot() {
  if (!bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || token === 'seu_token_aqui') {
      console.warn('[Bot] TELEGRAM_BOT_TOKEN não configurado. Bot desativado.');
      return null;
    }
    bot = new TelegramBot(token, { polling: false });
    console.log('[Bot] Telegram bot inicializado.');
  }
  return bot;
}

function formatPrice(value) {
  if (!value) return '-';
  return 'R$ ' + value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildMessage(promo) {
  const discount = promo.discount_percent;
  const hasDiscount = discount && discount > 0;
  const seller = promo.seller || 'loja parceira';

  // Emoji de fogo baseado no desconto
  let fire = '🔥';
  if (discount >= 50) fire = '🚨🔥🚨';
  else if (discount >= 30) fire = '💥🔥';

  let msg = '';

  // Cabeçalho chamativo
  msg += fire + ' <b>' + escapeHtml(promo.title) + '</b>\n\n';

  // Bloco de preços
  if (hasDiscount && promo.original_price) {
    msg += '💰 De: <s>' + escapeHtml(formatPrice(promo.original_price)) + '</s>\n';
    msg += '🏷 Por: <b>' + escapeHtml(formatPrice(promo.sale_price)) + '</b>';
    msg += '  ✅ <b>-' + discount + '% OFF</b>\n\n';
  } else if (promo.sale_price && promo.sale_price > 0) {
    msg += '🏷 <b>' + escapeHtml(formatPrice(promo.sale_price)) + '</b>';
    if (hasDiscount) msg += '  ✅ <b>-' + discount + '% OFF</b>';
    msg += '\n\n';
  } else if (hasDiscount) {
    msg += '✅ <b>' + discount + '% de desconto!</b>\n\n';
  }

  // Código do cupom em destaque
  if (promo.extra_info) {
    msg += '🎟 <b>' + escapeHtml(promo.extra_info) + '</b>\n\n';
  }

  msg += '━━━━━━━━━━━━━━━━━━\n';

  // Link com nome correto da loja
  const storeName = escapeHtml(seller);
  msg += '🛒 <a href="' + escapeHtml(promo.affiliate_url) + '">Comprar na ' + storeName + '</a>\n\n';

  msg += '<i>⏳ Oferta por tempo limitado — aproveite antes que acabe!</i>';

  return msg;
}

async function sendPromotion(promo) {
  const telegramBot = getBot();
  if (!telegramBot) return { success: false, reason: 'Bot não configurado' };

  const channels = (await getChannels()).filter(c => c.active); // await aqui
  if (channels.length === 0) {
    return { success: false, reason: 'Nenhum canal ativo configurado' };
  }

  const message = buildMessage(promo);
  const results = [];

  for (const channel of channels) {
    if (channel.category_filter) {
      const filters = channel.category_filter.split(',').map(f => f.trim().toLowerCase());
      const promoCategory = (promo.category || '').toLowerCase();
      const promoTitle = (promo.title || '').toLowerCase();
      const matches = filters.some(f => promoCategory.includes(f) || promoTitle.includes(f));
      if (!matches) {
        console.log('[Bot] Canal "' + channel.name + '" ignorou "' + promo.title.substring(0, 40) + '" (filtro)');
        continue;
      }
    }

    try {
      let sentMsg;
      if (promo.image_url) {
        try {
          sentMsg = await telegramBot.sendPhoto(channel.telegram_id, promo.image_url, {
            caption: message, parse_mode: 'HTML',
          });
        } catch {
          sentMsg = await telegramBot.sendMessage(channel.telegram_id, message, {
            parse_mode: 'HTML', disable_web_page_preview: false,
          });
        }
      } else {
        sentMsg = await telegramBot.sendMessage(channel.telegram_id, message, {
          parse_mode: 'HTML', disable_web_page_preview: false,
        });
      }

      await savePost({                                           // await aqui
        promotion_id: promo.id,
        channel_id: channel.id,
        telegram_message_id: String(sentMsg.message_id),
      });

      console.log('[Bot] Postado em "' + channel.name + '": ' + promo.title.substring(0, 50));
      results.push({ channel: channel.name, success: true });
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error('[Bot] Erro ao postar em "' + channel.name + '":', err.message);
      results.push({ channel: channel.name, success: false, error: err.message });
    }
  }

  return { success: results.some(r => r.success), results };
}

async function sendAlert(message) {
  const telegramBot = getBot();
  if (!telegramBot) return;

  const channels = (await getChannels()).filter(c => c.active); // await aqui
  for (const channel of channels) {
    try {
      await telegramBot.sendMessage(channel.telegram_id, message, { parse_mode: 'HTML' });
    } catch {}
  }
}

async function testConnection() {
  const telegramBot = getBot();
  if (!telegramBot) return { ok: false, error: 'Token não configurado' };

  try {
    const me = await telegramBot.getMe();
    return { ok: true, bot: me };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendPromotion, sendAlert, testConnection, buildMessage };
