require('dotenv').config();
const { startWebServer } = require('./web/server');
const { startScheduler } = require('./scheduler');
const { ensureSchema, saveChannel, getChannels } = require('./db/database');

async function main() {
  await ensureSchema(); // aguarda as tabelas serem criadas

  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   ⚡  PromoBot — Ofertas             ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN === 'seu_token_aqui') {
    console.warn('⚠  TELEGRAM_BOT_TOKEN não configurado. Bot rodará sem Telegram.');
    console.warn('   Configure no arquivo .env e reinicie.');
  }

  if (!process.env.ML_AFFILIATE_TAG || process.env.ML_AFFILIATE_TAG === 'seutag-55') {
    console.warn('⚠  ML_AFFILIATE_TAG não configurado. Links não terão afiliado.');
  }

  const channelIds = (process.env.TELEGRAM_CHANNEL_IDS || '').split(',').filter(Boolean);
  const existingChannels = await getChannels(); // await aqui

  if (channelIds.length > 0 && existingChannels.length === 0) {
    for (const [i, id] of channelIds.entries()) {
      await saveChannel({        // await aqui
        telegram_id: id.trim(),
        name: `Canal ${i + 1}`,
        category_filter: null,
        active: 1,
      });
    }
    console.log(`✓ ${channelIds.length} canal(is) carregado(s) do .env`);
  }

  startWebServer();
  startScheduler();

  console.log('');
  console.log('✓ PromoBot rodando!');
  console.log(`  Painel: http://localhost:${process.env.WEB_PORT || 3000}`);
  console.log('');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});