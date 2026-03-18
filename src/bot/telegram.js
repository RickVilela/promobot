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
  if (!value) return '–';
  return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildMessage(promo) {
  const discount = promo.discount_percent;
  const hasDiscount = discount && discount > 0;

  // Emojis por desconto
  let fire = '🔥';
  if (discount >= 50) fire = '🚨🔥';
  else if (discount >= 30) fire = '💥';

  let msg = '';

  // Título
  msg += `${fire} *${escapeMarkdown(promo.title)}*\n\n`;

  // Preços
  if (hasDiscount && promo.original_price) {
    msg += `~~${formatPrice(promo.original_price)}~~ → `;
  }
  msg += `*${formatPrice(promo.sale_price)}*`;

  if (hasDiscount) {
    msg += ` \\(\\-${discount}%\\)`;
  }

  msg += '\n\n';

  // Link de afiliado
  msg += `🛒 [Comprar no Mercado Livre](${promo.affiliate_url})\n\n`;

  // Rodapé
  msg += `_Promoção por tempo limitado\\. Clique rápido\\!_`;

  return msg;
}

function escapeMarkdown(text) {
  return (text || '')
    .replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

async function sendPromotion(promo) {
  const telegramBot = getBot();
  if (!telegramBot) return { success: false, reason: 'Bot não configurado' };

  const channels = getChannels().filter(c => c.active);
  if (channels.length === 0) {
    return { success: false, reason: 'Nenhum canal ativo configurado' };
  }

  const message = buildMessage(promo);
  const results = [];

  for (const channel of channels) {
    // Verifica filtro de categoria do canal
    if (channel.category_filter) {
      const filters = channel.category_filter.split(',').map(f => f.trim().toLowerCase());
      const promoCategory = (promo.category || '').toLowerCase();
      const promoTitle = (promo.title || '').toLowerCase();
      const matches = filters.some(f => promoCategory.includes(f) || promoTitle.includes(f));
      if (!matches) {
        console.log(`[Bot] Canal "${channel.name}" ignorou "${promo.title.substring(0, 40)}" (filtro)`);
        continue;
      }
    }

    try {
      let sentMsg;

      if (promo.image_url) {
        // Tenta enviar com imagem
        try {
          sentMsg = await telegramBot.sendPhoto(channel.telegram_id, promo.image_url, {
            caption: message,
            parse_mode: 'MarkdownV2',
          });
        } catch {
          // Fallback: envia só texto se a imagem falhar
          sentMsg = await telegramBot.sendMessage(channel.telegram_id, message, {
            parse_mode: 'MarkdownV2',
            disable_web_page_preview: false,
          });
        }
      } else {
        sentMsg = await telegramBot.sendMessage(channel.telegram_id, message, {
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: false,
        });
      }

      savePost({
        promotion_id: promo.id,
        channel_id: channel.id,
        telegram_message_id: String(sentMsg.message_id),
      });

      console.log(`[Bot] ✓ Postado em "${channel.name}": ${promo.title.substring(0, 50)}`);
      results.push({ channel: channel.name, success: true });

      // Delay entre canais para evitar rate limit
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`[Bot] Erro ao postar em "${channel.name}":`, err.message);
      results.push({ channel: channel.name, success: false, error: err.message });
    }
  }

  return { success: results.some(r => r.success), results };
}

async function sendAlert(message) {
  const telegramBot = getBot();
  if (!telegramBot) return;

  const channels = getChannels().filter(c => c.active);
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
