const express = require('express');
const path = require('path');
const axios = require('axios');
const {
  getHistory, getStats, getChannels, saveChannel,
  toggleChannel, markAsIgnored, getPendingPromotions,
  getSources, toggleSource,
} = require('../db/database');
const { runScrapeAndPost, getStatus } = require('../scheduler');
const { sendPromotion, testConnection, buildMessage } = require('../bot/telegram');
const { markAsPosted } = require('../db/database');

const app = express();
app.use(express.json());
// Serve static files (index.html, app.js, style.css) from /public
app.use(express.static(path.join(__dirname, '../../public')));

// ─── ML OAUTH ─────────────────────────────────────────────────
app.get('/ml/auth', (req, res) => {
  const appId = process.env.ML_APP_ID;
  if (!appId) return res.status(400).send('ML_APP_ID nao configurado');
  const redirectUri = process.env.APP_URL + '/ml/callback';
  res.redirect(`https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`);
});

app.get('/ml/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send('<h2>Erro no callback ML</h2>');
  try {
    const r = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'authorization_code', client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_APP_SECRET, code, redirect_uri: process.env.APP_URL + '/ml/callback',
    });
    process.env.ML_ACCESS_TOKEN  = r.data.access_token;
    process.env.ML_REFRESH_TOKEN = r.data.refresh_token;
    scheduleTokenRefresh(r.data.expires_in);
    res.send('<html><body><h2 style="color:#1D9E75">Token obtido!</h2><a href="/">Voltar</a></body></html>');
  } catch (err) {
    res.send('<h2>Erro ao obter token: ' + err.message + '</h2>');
  }
});

function scheduleTokenRefresh(expiresInSeconds) {
  setTimeout(async () => {
    try {
      const r = await axios.post('https://api.mercadolibre.com/oauth/token', {
        grant_type: 'refresh_token', client_id: process.env.ML_APP_ID,
        client_secret: process.env.ML_APP_SECRET, refresh_token: process.env.ML_REFRESH_TOKEN,
      });
      process.env.ML_ACCESS_TOKEN  = r.data.access_token;
      process.env.ML_REFRESH_TOKEN = r.data.refresh_token;
      scheduleTokenRefresh(r.data.expires_in);
    } catch (err) { console.error('[ML Auth] Erro renovacao:', err.message); }
  }, Math.max((expiresInSeconds - 300), 60) * 1000);
}

// ─── API ROUTES ────────────────────────────────────────────────
app.get('/api/stats',   (req, res) => res.json({ ...getStats(), scheduler: getStatus() }));
app.get('/api/status',  (req, res) => res.json(getStatus()));
app.get('/api/pending', (req, res) => res.json(getPendingPromotions()));
app.get('/api/history', (req, res) => res.json(getHistory(parseInt(req.query.limit)||50, parseInt(req.query.offset)||0)));
app.get('/api/sources', (req, res) => res.json(getSources()));
app.get('/api/channels',(req, res) => res.json(getChannels()));

app.post('/api/channels', (req, res) => {
  const { telegram_id, name, category_filter } = req.body;
  if (!telegram_id || !name) return res.status(400).json({ error: 'telegram_id e name obrigatorios' });
  saveChannel({ telegram_id, name, category_filter: category_filter || null, active: 1 });
  res.json({ ok: true });
});

app.patch('/api/channels/:id/toggle', (req, res) => {
  toggleChannel(parseInt(req.params.id));
  res.json({ ok: true });
});

app.patch('/api/sources/:id/toggle', (req, res) => {
  toggleSource(req.params.id);
  res.json({ ok: true });
});

app.post('/api/promotions/manual', (req, res) => {
  const { title, sale_price, original_price, affiliate_url, image_url, seller, extra_info } = req.body;
  if (!title || !affiliate_url) return res.status(400).json({ error: 'titulo e link obrigatorios' });
  const { savePromotion } = require('../db/database');
  const crypto = require('crypto');
  const sale = parseFloat(sale_price) || 0;
  const original = parseFloat(original_price) || null;
  let discount = null;
  if (original && sale && original > sale) discount = Math.round(((original - sale) / original) * 100);
  const saved = savePromotion({
    ml_id: 'MANUAL_' + crypto.randomBytes(8).toString('hex'),
    title: title.substring(0, 200), original_price: original, sale_price: sale,
    discount_percent: discount, image_url: image_url || null,
    original_url: affiliate_url, affiliate_url, category: seller || 'manual',
    seller: seller || null, source: 'manual', extra_info: extra_info || null,
  });
  res.json({ ok: true, saved, message: saved ? 'Adicionada a fila' : 'Ja existe' });
});

app.post('/api/promotions/:id/post', async (req, res) => {
  const promo = getPendingPromotions().find(p => p.id === parseInt(req.params.id));
  if (!promo) return res.status(404).json({ error: 'Nao encontrada' });
  const result = await sendPromotion(promo);
  if (result.success) markAsPosted(promo.id);
  res.json(result);
});

app.post('/api/promotions/:id/ignore', (req, res) => {
  markAsIgnored(parseInt(req.params.id));
  res.json({ ok: true });
});

app.get('/api/promotions/:id/preview', (req, res) => {
  const promo = [...getPendingPromotions(), ...getHistory(200, 0)].find(p => p.id === parseInt(req.params.id));
  if (!promo) return res.status(404).json({ error: 'Nao encontrada' });
  res.json({ message: buildMessage(promo) });
});

app.post('/api/scrape', async (req, res) => {
  if (getStatus().isRunning) return res.status(409).json({ error: 'Ja em andamento' });
  res.json({ ok: true, message: 'Scraping iniciado' });
  runScrapeAndPost();
});

// ─── WHATSAPP API ──────────────────────────────────────────────
app.get('/api/whatsapp/qrcode', async (req, res) => {
  const { WAPI_INSTANCE_ID: id, WAPI_TOKEN: token } = process.env;
  if (!id || !token) return res.status(400).json({ error: 'WAPI nao configurado' });
  try {
    const resp = await axios.get(
      `https://api.w-api.app/v1/instance/qr-code?instanceId=${id}&image=enable`,
      { headers: { 'Authorization': 'Bearer ' + token }, responseType: 'arraybuffer', timeout: 15000 }
    );
    const ct = resp.headers['content-type'] || 'image/png';
    res.json({ base64: `data:${ct};base64,${Buffer.from(resp.data).toString('base64')}` });
  } catch (err) {
    try {
      const r2 = await axios.get(
        `https://api.w-api.app/v1/instance/qr-code?instanceId=${id}&image=enable`,
        { headers: { 'Authorization': 'Bearer ' + token }, timeout: 15000 }
      );
      res.json(r2.data);
    } catch { res.status(500).json({ error: err.message }); }
  }
});

app.get('/api/whatsapp/channels', (req, res) => {
  const channels = (process.env.WAPI_CHANNELS || '').split(',').filter(Boolean).map(s => s.trim());
  res.json({ channels, configured: !!(process.env.WAPI_INSTANCE_ID && process.env.WAPI_TOKEN) });
});

app.get('/api/whatsapp/status', async (req, res) => {
  const { WAPI_INSTANCE_ID: id, WAPI_TOKEN: token } = process.env;
  if (!id || !token) return res.json({ connected: false, error: 'Nao configurado' });
  try {
    const resp = await axios.get(
      `https://api.w-api.app/v1/instance/status-instance?instanceId=${id}`,
      { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 }
    );
    res.json({ connected: resp.data.connected === true, data: resp.data });
  } catch (err) { res.json({ connected: false, error: err.message }); }
});

app.get('/api/whatsapp/test', async (req, res) => {
  const { testConnection: waTest } = require('../bot/whatsapp');
  res.json(await waTest());
});

app.get('/api/telegram/test', async (req, res) => res.json(await testConnection()));

// ─── START ─────────────────────────────────────────────────────
function startWebServer() {
  const port = process.env.WEB_PORT || 3000;
  app.listen(port, () => console.log(`[Web] Painel em: http://localhost:${port}`));
  return app;
}

module.exports = { startWebServer, app };