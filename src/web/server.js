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
app.use(express.static(path.join(__dirname, '../../public')));

// ─── ML OAUTH CALLBACK ─────────────────────────────────────────

// Passo 1: redireciona para login do ML
app.get('/ml/auth', (req, res) => {
  const appId = process.env.ML_APP_ID;
  if (!appId) return res.status(400).send('ML_APP_ID não configurado no .env');
  const redirectUri = process.env.APP_URL + '/ml/callback';
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

// Passo 2: ML redireciona aqui com o code, troca pelo token automaticamente
app.get('/ml/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`<h2>Erro: ${error}</h2><p>Tente novamente em <a href="/ml/auth">/ml/auth</a></p>`);
  }

  if (!code) {
    return res.send('<h2>Código não recebido.</h2>');
  }

  try {
    const appId     = process.env.ML_APP_ID;
    const appSecret = process.env.ML_APP_SECRET;
    const redirectUri = process.env.APP_URL + '/ml/callback';

    const response = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type:    'authorization_code',
      client_id:     appId,
      client_secret: appSecret,
      code:          code,
      redirect_uri:  redirectUri,
    });

    const { access_token, refresh_token, expires_in } = response.data;

    // Salva nos env em runtime (Railway vai usar as vars do painel)
    process.env.ML_ACCESS_TOKEN  = access_token;
    process.env.ML_REFRESH_TOKEN = refresh_token;

    console.log('[ML Auth] Token obtido com sucesso! Expira em', expires_in, 'segundos');

    // Agenda renovação automática 5 min antes de expirar
    scheduleTokenRefresh(expires_in);

    res.send(`
      <html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;padding:20px">
        <h2 style="color:#1D9E75">✓ Token obtido com sucesso!</h2>
        <p>O bot já está autenticado e vai buscar promoções automaticamente.</p>
        <p style="font-size:12px;color:#888">Expira em ${Math.round(expires_in/3600)}h — renovação automática ativa.</p>
        <p><a href="/">← Voltar ao painel</a></p>
      </body></html>
    `);

  } catch (err) {
    console.error('[ML Auth] Erro ao trocar código por token:', err.response?.data || err.message);
    res.send(`
      <html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;padding:20px">
        <h2 style="color:#E24B4A">✗ Erro ao obter token</h2>
        <pre style="background:#f5f5f5;padding:12px;border-radius:8px;font-size:12px">${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>
        <p><a href="/ml/auth">Tentar novamente</a></p>
      </body></html>
    `);
  }
});

// Renovação automática do token
function scheduleTokenRefresh(expiresInSeconds) {
  const refreshIn = Math.max((expiresInSeconds - 300), 60) * 1000; // 5 min antes
  console.log(`[ML Auth] Renovação do token agendada em ${Math.round(refreshIn/60000)} min`);

  setTimeout(async () => {
    try {
      const response = await axios.post('https://api.mercadolibre.com/oauth/token', {
        grant_type:    'refresh_token',
        client_id:     process.env.ML_APP_ID,
        client_secret: process.env.ML_APP_SECRET,
        refresh_token: process.env.ML_REFRESH_TOKEN,
      });

      process.env.ML_ACCESS_TOKEN  = response.data.access_token;
      process.env.ML_REFRESH_TOKEN = response.data.refresh_token;
      console.log('[ML Auth] Token renovado automaticamente!');
      scheduleTokenRefresh(response.data.expires_in);

    } catch (err) {
      console.error('[ML Auth] Erro ao renovar token:', err.response?.data || err.message);
      console.error('[ML Auth] Acesse /ml/auth para autenticar novamente.');
    }
  }, refreshIn);
}

// Status do token ML
app.get('/api/ml/status', (req, res) => {
  const token = process.env.ML_ACCESS_TOKEN;
  res.json({
    configured: !!token && token !== 'seu_token_aqui',
    token_preview: token ? token.substring(0, 20) + '...' : null,
  });
});

// ─── API ROUTES ────────────────────────────────────────────────

// Stats
app.get('/api/stats', (req, res) => {
  res.json({ ...getStats(), scheduler: getStatus() });
});

// Histórico
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  res.json(getHistory(limit, offset));
});

// Promos pendentes
app.get('/api/pending', (req, res) => {
  res.json(getPendingPromotions());
});

// Canais
app.get('/api/channels', (req, res) => {
  res.json(getChannels());
});

app.post('/api/channels', (req, res) => {
  const { telegram_id, name, category_filter } = req.body;
  if (!telegram_id || !name) return res.status(400).json({ error: 'telegram_id e name são obrigatórios' });
  saveChannel({ telegram_id, name, category_filter: category_filter || null, active: 1 });
  res.json({ ok: true });
});

app.patch('/api/channels/:id/toggle', (req, res) => {
  toggleChannel(parseInt(req.params.id));
  res.json({ ok: true });
});

// Ações em promoções
app.post('/api/promotions/:id/post', async (req, res) => {
  const promos = getPendingPromotions();
  const promo = promos.find(p => p.id === parseInt(req.params.id));
  if (!promo) return res.status(404).json({ error: 'Promoção não encontrada ou já postada' });

  const result = await sendPromotion(promo);
  if (result.success) markAsPosted(promo.id);
  res.json(result);
});

app.post('/api/promotions/:id/ignore', (req, res) => {
  markAsIgnored(parseInt(req.params.id));
  res.json({ ok: true });
});

// Preview da mensagem
app.get('/api/promotions/:id/preview', (req, res) => {
  const promos = getPendingPromotions();
  const all = getHistory(200, 0);
  const promo = [...promos, ...all].find(p => p.id === parseInt(req.params.id));
  if (!promo) return res.status(404).json({ error: 'Não encontrada' });
  res.json({ message: buildMessage(promo) });
});

// Forçar scraping manual
app.post('/api/scrape', async (req, res) => {
  const status = getStatus();
  if (status.isRunning) return res.status(409).json({ error: 'Scraping já em andamento' });
  res.json({ ok: true, message: 'Scraping iniciado' });
  runScrapeAndPost(); // não await — responde imediatamente
});

// Fontes
app.get('/api/sources', (req, res) => {
  res.json(getSources());
});

app.patch('/api/sources/:id/toggle', (req, res) => {
  toggleSource(req.params.id);
  res.json({ ok: true });
});

// QR Code WhatsApp
app.get('/api/whatsapp/qrcode', async (req, res) => {
  const instanceId = process.env.WAPI_INSTANCE_ID;
  const token = process.env.WAPI_TOKEN;
  if (!instanceId || !token) return res.status(400).json({ error: 'WAPI_INSTANCE_ID ou WAPI_TOKEN não configurados' });
  try {
    const axios = require('axios');
    const resp = await axios.get(
      `https://api.w-api.app/v1/instance/qr-code?instanceId=${instanceId}&image=enable`,
      { headers: { 'Authorization': 'Bearer ' + token }, timeout: 15000 }
    );
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// Canais WhatsApp configurados
app.get('/api/whatsapp/channels', (req, res) => {
  const channels = (process.env.WAPI_CHANNELS || '').split(',').filter(Boolean).map(s => s.trim());
  res.json({ channels, configured: !!(process.env.WAPI_INSTANCE_ID && process.env.WAPI_TOKEN) });
});

// Status da instância WhatsApp
app.get('/api/whatsapp/status', async (req, res) => {
  const instanceId = process.env.WAPI_INSTANCE_ID;
  const token = process.env.WAPI_TOKEN;
  if (!instanceId || !token) return res.json({ connected: false, error: 'Não configurado' });
  try {
    const axios = require('axios');
    const resp = await axios.get(
      `https://api.w-api.app/v1/instance/info?instanceId=${instanceId}`,
      { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 }
    );
    res.json({ connected: true, data: resp.data });
  } catch (err) {
    res.json({ connected: false, error: err.response?.data?.message || err.message });
  }
});

// Testar WhatsApp
app.get('/api/whatsapp/test', async (req, res) => {
  const { testConnection } = require('../bot/whatsapp');
  const result = await testConnection();
  res.json(result);
});

// Testar conexão Telegram
app.get('/api/telegram/test', async (req, res) => {
  const result = await testConnection();
  res.json(result);
});

// Status do scheduler
app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

// ─── PAINEL WEB ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(HTML_DASHBOARD);
});

// ─── HTML DO PAINEL ────────────────────────────────────────────
const HTML_DASHBOARD = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PromoBot — Painel</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d0e10;
    --surface: #16181c;
    --surface2: #1e2026;
    --border: #2a2d35;
    --text: #e8eaf0;
    --muted: #6b7280;
    --accent: #00c853;
    --accent-dim: #003d19;
    --warn: #ff9100;
    --warn-dim: #3d2400;
    --danger: #ff4444;
    --info: #3b82f6;
    --info-dim: #0f1f3d;
    --mono: 'DM Mono', monospace;
    --sans: 'DM Sans', sans-serif;
    --radius: 10px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--sans); background: var(--bg); color: var(--text); min-height: 100vh; font-size: 14px; }

  /* Layout */
  .app { display: flex; min-height: 100vh; }
  .sidebar { width: 220px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; position: fixed; top: 0; left: 0; height: 100vh; z-index: 100; }
  .main { margin-left: 220px; flex: 1; display: flex; flex-direction: column; }
  .topbar { padding: 16px 28px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 50; }
  .content { padding: 24px 28px; flex: 1; }

  /* Sidebar */
  .logo { padding: 20px 18px 16px; border-bottom: 1px solid var(--border); }
  .logo-title { font-size: 17px; font-weight: 600; color: var(--accent); letter-spacing: -0.3px; }
  .logo-sub { font-size: 11px; color: var(--muted); margin-top: 2px; font-family: var(--mono); }
  .nav { padding: 10px 8px; flex: 1; }
  .nav-label { font-size: 10px; color: var(--muted); padding: 8px 8px 4px; text-transform: uppercase; letter-spacing: 1px; }
  .nav-item { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 8px; cursor: pointer; color: var(--muted); font-size: 13px; margin-bottom: 1px; transition: all 0.15s; border: 1px solid transparent; }
  .nav-item:hover { background: var(--surface2); color: var(--text); }
  .nav-item.active { background: var(--accent-dim); color: var(--accent); border-color: #00c85330; font-weight: 500; }
  .nav-icon { font-size: 15px; width: 18px; text-align: center; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-left: auto; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  /* Topbar */
  .page-title { font-size: 16px; font-weight: 600; }
  .btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; border: 1px solid var(--border); background: var(--surface2); color: var(--text); font-family: var(--sans); font-weight: 500; transition: all 0.15s; display: inline-flex; align-items: center; gap: 6px; }
  .btn:hover { border-color: #444; background: #2a2d35; }
  .btn:active { transform: scale(0.97); }
  .btn-green { background: var(--accent); color: #000; border-color: var(--accent); }
  .btn-green:hover { background: #00e060; }
  .btn-row { display: flex; gap: 8px; }

  /* Stats */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
  .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .stat-value { font-size: 28px; font-weight: 600; font-family: var(--mono); color: var(--text); }
  .stat-sub { font-size: 11px; color: var(--accent); margin-top: 4px; }
  .stat.warn .stat-value { color: var(--warn); }
  .stat.green .stat-value { color: var(--accent); }

  /* Section */
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

  /* Badges */
  .badge { font-size: 11px; padding: 3px 9px; border-radius: 20px; font-weight: 500; font-family: var(--mono); display: inline-flex; align-items: center; gap: 4px; }
  .badge-green { background: var(--accent-dim); color: var(--accent); }
  .badge-warn { background: var(--warn-dim); color: var(--warn); }
  .badge-gray { background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }
  .badge-info { background: var(--info-dim); color: var(--info); }
  .badge-danger { background: #3d0000; color: var(--danger); }

  /* Promo cards */
  .promo-list { display: flex; flex-direction: column; gap: 8px; }
  .promo-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; display: flex; gap: 14px; align-items: flex-start; transition: border-color 0.15s; }
  .promo-card:hover { border-color: #3a3d45; }
  .promo-thumb { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; background: var(--surface2); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 24px; border: 1px solid var(--border); overflow: hidden; }
  .promo-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .promo-info { flex: 1; min-width: 0; }
  .promo-title { font-size: 13px; font-weight: 500; color: var(--text); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .promo-prices { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .promo-sale { font-size: 15px; font-weight: 600; color: var(--accent); font-family: var(--mono); }
  .promo-original { font-size: 12px; color: var(--muted); text-decoration: line-through; font-family: var(--mono); }
  .promo-meta { font-size: 11px; color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; }
  .promo-link { font-size: 11px; color: var(--info); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
  .promo-actions { display: flex; gap: 6px; align-items: flex-start; flex-shrink: 0; padding-top: 2px; }
  .icon-btn { width: 30px; height: 30px; border-radius: 7px; border: 1px solid var(--border); background: var(--surface2); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; transition: all 0.15s; }
  .icon-btn:hover { background: var(--surface); border-color: #444; }
  .icon-btn.green:hover { border-color: var(--accent); color: var(--accent); }
  .icon-btn.danger:hover { border-color: var(--danger); color: var(--danger); }

  /* Channels */
  .channels-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .channel-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .channel-name { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .channel-id { font-size: 11px; color: var(--muted); font-family: var(--mono); }
  .channel-filter { font-size: 11px; color: var(--info); margin-top: 4px; }
  .channel-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
  .toggle-wrap { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .toggle { width: 36px; height: 20px; border-radius: 10px; background: var(--muted); position: relative; transition: background 0.2s; cursor: pointer; }
  .toggle.on { background: var(--accent); }
  .toggle::after { content: ''; width: 16px; height: 16px; border-radius: 50%; background: #fff; position: absolute; top: 2px; left: 2px; transition: transform 0.2s; }
  .toggle.on::after { transform: translateX(16px); }
  .add-channel-card { border: 1px dashed var(--border); background: transparent; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--muted); font-size: 13px; min-height: 120px; }
  .add-channel-card:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
  .modal-overlay.show { opacity: 1; pointer-events: all; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 24px; width: 420px; max-width: 90vw; }
  .modal-title { font-size: 16px; font-weight: 600; margin-bottom: 18px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .field input, .field select { width: 100%; padding: 9px 12px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: var(--sans); font-size: 13px; outline: none; transition: border-color 0.15s; }
  .field input:focus, .field select:focus { border-color: var(--accent); }

  /* Status bar */
  .status-bar { display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--muted); font-family: var(--mono); }
  .status-indicator { display: flex; align-items: center; gap: 5px; }
  .indicator-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .indicator-dot.off { background: var(--muted); }
  .indicator-dot.running { background: var(--warn); animation: pulse 1s infinite; }

  /* Tabs */
  .tabs { display: flex; gap: 2px; background: var(--surface2); border-radius: 9px; padding: 3px; margin-bottom: 18px; width: fit-content; }
  .tab { padding: 6px 16px; border-radius: 7px; font-size: 13px; cursor: pointer; color: var(--muted); font-weight: 500; transition: all 0.15s; }
  .tab.active { background: var(--surface); color: var(--text); }

  /* Toast */
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 18px; font-size: 13px; z-index: 9999; transform: translateY(80px); opacity: 0; transition: all 0.3s; max-width: 320px; }
  .toast.show { transform: translateY(0); opacity: 1; }
  .toast.success { border-color: var(--accent); }
  .toast.error { border-color: var(--danger); }

  /* Loader */
  .loader { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Empty */
  .empty { text-align: center; padding: 40px; color: var(--muted); font-size: 13px; }
  .empty-icon { font-size: 32px; margin-bottom: 10px; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  .sources-grid { display:flex;flex-direction:column;gap:10px; }
  .source-card { background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;transition:border-color 0.15s; }
  .source-card.active { border-color:#1D9E7540; }
  .source-head { display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px; }
  .source-name { font-size:13px;font-weight:500;color:var(--text); }
  .source-desc { font-size:11px;color:var(--muted);margin-top:2px; }
  .source-footer { display:flex;align-items:center;justify-content:space-between;gap:8px; }
  .source-cred { margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
  .source-cred code { font-family:var(--mono);font-size:11px;background:var(--surface2);padding:2px 7px;border-radius:5px;color:var(--accent); }
  .badge-info { background:var(--info-dim);color:var(--info); }
  @media (max-width: 900px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .channels-grid { grid-template-columns: 1fr 1fr; }
    .sidebar { width: 180px; }
    .main { margin-left: 180px; }
  }
</style>
</head>
<body>

<div class="app">
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="logo">
      <div class="logo-title">⚡ PromoBot</div>
      <div class="logo-sub">mercadolivre + telegram</div>
    </div>
    <div class="nav">
      <div class="nav-label">Menu</div>
      <div class="nav-item active" onclick="navigate('dashboard', this)"><span class="nav-icon">◈</span> Dashboard <span class="status-dot" id="running-dot" style="display:none"></span></div>
      <div class="nav-item" onclick="navigate('pending', this)"><span class="nav-icon">◷</span> Pendentes <span id="pending-count" style="margin-left:auto;font-size:10px;"></span></div>
      <div class="nav-item" onclick="navigate('history', this)"><span class="nav-icon">◎</span> Histórico</div>
      <div class="nav-item" onclick="navigate('channels', this)"><span class="nav-icon">◉</span> Canais</div>
      <div class="nav-item" onclick="navigate('sources', this)"><span class="nav-icon">◍</span> Fontes</div>
      <div class="nav-label">Sistema</div>
      <div class="nav-item" onclick="navigate('whatsapp', this)"><span class="nav-icon">◌</span> WhatsApp</div>
      <div class="nav-item" onclick="navigate('settings', this)"><span class="nav-icon">◐</span> Configuração</div>
    </div>
  </div>

  <!-- Main -->
  <div class="main">
    <div class="topbar">
      <div class="page-title" id="page-title">Dashboard</div>
      <div class="btn-row">
        <div class="status-bar">
          <div class="status-indicator">
            <div class="indicator-dot" id="status-dot"></div>
            <span id="status-text">verificando...</span>
          </div>
        </div>
        <button class="btn" onclick="forceScrape(this)">
          <span>↻</span> Buscar agora
        </button>
      </div>
    </div>
    <div class="content" id="content">
      <div class="empty"><div class="loader"></div></div>
    </div>
  </div>
</div>

<!-- Modal Adicionar Canal -->
<div class="modal-overlay" id="channel-modal">
  <div class="modal">
    <div class="modal-title">Adicionar canal Telegram</div>
    <div class="field">
      <label>ID do Canal</label>
      <input type="text" id="ch-id" placeholder="-1001234567890" />
      <div style="font-size:11px;color:var(--muted);margin-top:4px;">Adicione @userinfobot ao canal e envie /start para obter o ID</div>
    </div>
    <div class="field">
      <label>Nome do canal</label>
      <input type="text" id="ch-name" placeholder="Ex: Promos Tech BR" />
    </div>
    <div class="field">
      <label>Filtro de categorias (opcional)</label>
      <input type="text" id="ch-filter" placeholder="smartphone,notebook,tv" />
      <div style="font-size:11px;color:var(--muted);margin-top:4px;">Palavras-chave separadas por vírgula. Deixe vazio para receber tudo.</div>
    </div>
    <div class="btn-row" style="justify-content:flex-end;margin-top:6px;">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="saveChannel()">Salvar canal</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
let currentPage = 'dashboard';
let statsInterval;

// ─── NAVIGATION ───────────────────────────────────────────────
function navigate(page, el) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('page-title').textContent = {
    dashboard: 'Dashboard', pending: 'Promoções pendentes',
    history: 'Histórico', channels: 'Canais Telegram', settings: 'Configuração'
  }[page] || page;
  render(page);
}

async function render(page) {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty"><div class="loader"></div></div>';
  if (page === 'dashboard') await renderDashboard();
  else if (page === 'pending') await renderPending();
  else if (page === 'history') await renderHistory();
  else if (page === 'channels') await renderChannels();
  else if (page === 'sources') await renderSources();
  else if (page === 'whatsapp') await renderWhatsApp();
  else if (page === 'settings') renderSettings();
}

// ─── STATUS ───────────────────────────────────────────────────
async function updateStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    const running = document.getElementById('running-dot');

    if (s.isRunning) {
      dot.className = 'indicator-dot running';
      txt.textContent = 'buscando...';
      if (running) running.style.display = '';
    } else {
      dot.className = 'indicator-dot';
      const next = s.nextRunAt ? new Date(s.nextRunAt) : null;
      txt.textContent = next ? 'próxima: ' + next.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'aguardando';
      if (running) running.style.display = 'none';
    }
  } catch {}
}

// ─── DASHBOARD ────────────────────────────────────────────────
async function renderDashboard() {
  const [stats, history] = await Promise.all([
    fetch('/api/stats').then(r => r.json()),
    fetch('/api/history?limit=10').then(r => r.json()),
  ]);

  const s = stats;
  document.getElementById('pending-count').textContent = s.pending > 0 ? s.pending : '';

  document.getElementById('content').innerHTML = \`
    <div class="stats">
      <div class="stat green">
        <div class="stat-label">Postadas hoje</div>
        <div class="stat-value">\${s.today}</div>
        <div class="stat-sub">promoções encontradas</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total postadas</div>
        <div class="stat-value">\${s.posted}</div>
        <div class="stat-sub">no histórico</div>
      </div>
      <div class="stat warn">
        <div class="stat-label">Pendentes</div>
        <div class="stat-value">\${s.pending}</div>
        <div class="stat-sub">aguardando postar</div>
      </div>
      <div class="stat">
        <div class="stat-label">Desconto médio</div>
        <div class="stat-value">\${s.avgDiscount}%</div>
        <div class="stat-sub">nas promoções</div>
      </div>
    </div>
    <div class="section-header">
      <div class="section-title">Últimas promoções</div>
    </div>
    \${renderPromoList(history.slice(0, 8), false)}
  \`;
}

// ─── PENDING ──────────────────────────────────────────────────
async function renderPending() {
  const data = await fetch('/api/pending').then(r => r.json());
  document.getElementById('content').innerHTML = \`
    <div class="section-header">
      <div class="section-title">Aguardando postagem</div>
      <span class="badge badge-warn">\${data.length} pendentes</span>
    </div>
    \${data.length === 0
      ? '<div class="empty"><div class="empty-icon">✓</div>Nenhuma promoção pendente</div>'
      : renderPromoList(data, true)
    }
  \`;
}

// ─── HISTORY ──────────────────────────────────────────────────
let histTab = 'all';
async function renderHistory() {
  const data = await fetch('/api/history?limit=50').then(r => r.json());
  const filtered = histTab === 'all' ? data :
    histTab === 'posted' ? data.filter(p => p.status === 'posted') :
    data.filter(p => p.status !== 'posted');

  document.getElementById('content').innerHTML = \`
    <div class="tabs">
      <div class="tab \${histTab==='all'?'active':''}" onclick="setHistTab('all')">Todos</div>
      <div class="tab \${histTab==='posted'?'active':''}" onclick="setHistTab('posted')">Postados</div>
      <div class="tab \${histTab==='other'?'active':''}" onclick="setHistTab('other')">Outros</div>
    </div>
    \${filtered.length === 0
      ? '<div class="empty"><div class="empty-icon">📋</div>Nenhuma promoção ainda</div>'
      : renderPromoList(filtered, false)
    }
  \`;
}

function setHistTab(tab) {
  histTab = tab;
  renderHistory().then(() => {
    document.getElementById('content').querySelector('.tabs')
      ?.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', ['all','posted','other'][i] === tab);
      });
  });
}

// ─── CHANNELS ─────────────────────────────────────────────────
async function renderChannels() {
  const data = await fetch('/api/channels').then(r => r.json());
  const cards = data.map(c => \`
    <div class="channel-card" id="ch-\${c.id}">
      <div class="channel-name">
        <span>\${c.active ? '🟢' : '⚫'}</span> \${escHtml(c.name)}
      </div>
      <div class="channel-id">\${c.telegram_id}</div>
      \${c.category_filter ? \`<div class="channel-filter">filtro: \${escHtml(c.category_filter)}</div>\` : ''}
      <div class="channel-footer">
        <span class="badge \${c.active ? 'badge-green' : 'badge-gray'}">\${c.active ? 'ativo' : 'pausado'}</span>
        <div class="toggle \${c.active ? 'on' : ''}" onclick="toggleCh(\${c.id})"></div>
      </div>
    </div>
  \`).join('');

  document.getElementById('content').innerHTML = \`
    <div class="section-header">
      <div class="section-title">Canais configurados</div>
    </div>
    <div class="channels-grid">
      \${cards}
      <div class="channel-card add-channel-card" onclick="openModal()">
        <div style="font-size:24px">+</div>
        <div>Adicionar canal</div>
      </div>
    </div>
    <div style="margin-top:20px;padding:16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);">
      <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Como adicionar o bot ao canal</div>
      <ol style="font-size:12px;color:var(--muted);padding-left:16px;line-height:2;">
        <li>Crie um bot com @BotFather no Telegram → anote o token</li>
        <li>Adicione o bot como <strong style="color:var(--text)">administrador</strong> do seu canal</li>
        <li>Adicione @userinfobot ao canal → envie /start para obter o ID</li>
        <li>Cole o ID aqui (começa com -100...)</li>
      </ol>
    </div>
  \`;
}

async function toggleCh(id) {
  await fetch(\`/api/channels/\${id}/toggle\`, { method: 'PATCH' });
  renderChannels();
  toast('Canal atualizado', 'success');
}

// ─── SOURCES ──────────────────────────────────────────────────
async function renderSources() {
  const data = await fetch('/api/sources').then(r => r.json());

  const sourceInfo = {
    shopee:      { icon: '🧡', label: 'Shopee — Ofertas do dia', desc: 'API oficial de afiliados Shopee', cred: 'SHOPEE_APP_ID + SHOPEE_SECRET', link: 'https://affiliate.shopee.com.br' },
    rakuten:        { icon: '🏪', label: 'Rakuten — Coupon Feed', desc: 'Americanas, Netshoes, Centauro e +50 lojas BR', cred: 'RAKUTEN_WS_TOKEN', link: 'https://publisher.rakutenadvertising.com' },
    pelando_hot:    { icon: '🔥', label: 'Pelando — Quentes', desc: 'Promoções mais votadas da comunidade', cred: 'sem configuração', link: null },
    pelando_recent: { icon: '🆕', label: 'Pelando — Recentes', desc: 'Promoções postadas recentemente', cred: 'sem configuração', link: null },
    shopee_kw:   { icon: '🔎', label: 'Shopee — Palavras-chave', desc: 'Busca por keyword na API Shopee', cred: 'SHOPEE_APP_ID + SHOPEE_SECRET', link: 'https://affiliate.shopee.com.br' },
  };

  const cards = data.map(s => {
    const info = sourceInfo[s.id] || { icon: '◉', label: s.name, desc: '', cred: '' };
    const lastRun = s.last_run ? timeAgo(s.last_run) : 'nunca';
    const needsSetup = (s.id.startsWith('shopee') && (!window._shopeeOk));
    return \`
      <div class="source-card \${s.active ? 'active' : ''}">
        <div class="source-head">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:22px">\${info.icon}</span>
            <div>
              <div class="source-name">\${info.label}</div>
              <div class="source-desc">\${info.desc}</div>
            </div>
          </div>
          <div class="toggle \${s.active ? 'on' : ''}" onclick="toggleSrc('\${s.id}', this)"></div>
        </div>
        <div class="source-footer">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <span class="badge \${s.active ? 'badge-green' : 'badge-gray'}">\${s.active ? 'ativo' : 'inativo'}</span>
            \${s.last_count > 0 ? \`<span class="badge badge-info">\${s.last_count} últimas promos</span>\` : ''}
            <span style="font-size:11px;color:var(--muted)">última busca: \${lastRun}</span>
          </div>
          \${info.link ? \`<a href="\${info.link}" target="_blank" style="font-size:11px;color:var(--info)">Cadastrar →</a>\` : ''}
        </div>
        \${needsSetup || s.id.startsWith('shopee') ? \`
          <div class="source-cred">
            <span style="font-size:11px;color:var(--muted)">Variáveis necessárias:</span>
            <code>\${info.cred}</code>
            \${s.id === 'shopee' || s.id === 'shopee_kw' ? '<span style="font-size:11px;color:var(--warn)">⚠ Configure no Railway para ativar</span>' : ''}
          </div>
        \` : ''}
      </div>
    \`;
  }).join('');

  document.getElementById('content').innerHTML = \`
    <div class="section-header">
      <div class="section-title">Fontes de promoção</div>
      <button class="btn" style="font-size:12px;padding:4px 10px;" onclick="forceScrape(this)">↻ Buscar agora</button>
    </div>
    <div class="sources-grid">\${cards}</div>
    <div style="margin-top:16px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;color:var(--muted);line-height:2">
      <div style="font-weight:600;color:var(--text);margin-bottom:6px">Como adicionar a Shopee</div>
      <div>1. Cadastre-se em <a href="https://affiliate.shopee.com.br" target="_blank" style="color:var(--info)">affiliate.shopee.com.br</a> e aguarde aprovação</div>
      <div>2. No painel de afiliados, copie o <strong style="color:var(--text)">App ID</strong> e o <strong style="color:var(--text)">Secret Key</strong></div>
      <div>3. No Railway, adicione as variáveis: <code style="color:var(--accent)">SHOPEE_APP_ID</code> e <code style="color:var(--accent)">SHOPEE_SECRET</code></div>
      <div>4. Ative a fonte Shopee aqui no painel — o bot já começa a buscar automaticamente</div>
    </div>
  \`;
}

async function toggleSrc(id, toggleEl) {
  await fetch(\`/api/sources/\${id}/toggle\`, { method: 'PATCH' });
  toggleEl.classList.toggle('on');
  const card = toggleEl.closest('.source-card');
  card.classList.toggle('active');
  const badge = card.querySelector('.badge');
  const isOn = toggleEl.classList.contains('on');
  badge.className = 'badge ' + (isOn ? 'badge-green' : 'badge-gray');
  badge.textContent = isOn ? 'ativo' : 'inativo';
  toast(isOn ? 'Fonte ativada' : 'Fonte desativada', 'success');
}

// ─── WHATSAPP ─────────────────────────────────────────────────
async function renderWhatsApp() {
  document.getElementById('content').innerHTML = `
    <div style="max-width:480px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">Status da conexão</div>
        <div id="wa-status" style="font-size:12px;color:var(--muted)">Verificando...</div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-green" onclick="loadQR(this)">📱 Gerar QR Code</button>
          <button class="btn" onclick="checkWaStatus()">↻ Verificar status</button>
        </div>
      </div>
      <div id="qr-box" style="display:none;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;text-align:center;margin-bottom:14px">
        <div style="font-size:13px;font-weight:600;margin-bottom:12px">Escaneie com seu WhatsApp</div>
        <div id="qr-content" style="min-height:200px;display:flex;align-items:center;justify-content:center">
          <div class="loader"></div>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:10px">Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo</div>
        <div style="margin-top:10px;display:flex;gap:8px;justify-content:center">
          <button class="btn" onclick="loadQR(this)">↻ Atualizar QR</button>
          <button class="btn" onclick="document.getElementById('qr-box').style.display='none'">Fechar</button>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">Canais configurados</div>
        <div style="font-size:12px;color:var(--muted);line-height:2;font-family:var(--mono)" id="wa-channels">
          Carregando...
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">Como conectar</div>
        <ol style="font-size:12px;color:var(--muted);padding-left:16px;line-height:2.2">
          <li>Clique em <strong style="color:var(--text)">Gerar QR Code</strong></li>
          <li>Abra o WhatsApp no celular</li>
          <li>Toque em <strong style="color:var(--text)">⋮ → Dispositivos conectados</strong></li>
          <li>Toque em <strong style="color:var(--text)">Conectar dispositivo</strong></li>
          <li>Escaneie o QR code que aparece acima</li>
          <li>Aguarde a confirmação de conexão</li>
        </ol>
        <div style="margin-top:10px;font-size:11px;color:var(--muted)">
          Variáveis necessárias no Railway:
          <code style="color:var(--accent);display:block;margin-top:4px">WAPI_INSTANCE_ID=sua_instance_id</code>
          <code style="color:var(--accent);display:block">WAPI_TOKEN=seu_token</code>
          <code style="color:var(--accent);display:block">WAPI_CHANNELS=5511999999999</code>
        </div>
      </div>
    </div>
  \`;
  checkWaStatus();
}

async function loadQR(btn) {
  btn.innerHTML = '<div class="loader"></div>';
  btn.disabled = true;
  document.getElementById('qr-box').style.display = '';
  document.getElementById('qr-content').innerHTML = '<div class="loader"></div>';

  try {
    const r = await fetch('/api/whatsapp/qrcode').then(res => res.json());
    if (r.error) {
      document.getElementById('qr-content').innerHTML = \`<div style="color:var(--danger);font-size:13px">\${r.error}</div>\`;
    } else if (r.base64 || r.qrcode || r.image || r.data) {
      const img = r.base64 || r.qrcode || r.image || r.data;
      const src = img.startsWith('data:') ? img : 'data:image/png;base64,' + img;
      document.getElementById('qr-content').innerHTML = \`<img src="\${src}" style="max-width:240px;border-radius:8px">\`;
    } else {
      document.getElementById('qr-content').innerHTML = \`<pre style="font-size:10px;color:var(--text);">\${JSON.stringify(r, null, 2)}</pre>\`;
    }
  } catch (err) {
    document.getElementById('qr-content').innerHTML = \`<div style="color:var(--danger);font-size:13px">Erro: \${err.message}</div>\`;
  }

  btn.innerHTML = '📱 Gerar QR Code';
  btn.disabled = false;
}

async function checkWaStatus() {
  const el = document.getElementById('wa-status');
  if (!el) return;
  el.textContent = 'Verificando...';

  // Carrega canais
  try {
    const ch = await fetch('/api/whatsapp/channels').then(r => r.json());
    const chEl = document.getElementById('wa-channels');
    if (chEl) {
      chEl.innerHTML = ch.channels.length
        ? ch.channels.map(c => \`<div>\${c}</div>\`).join('')
        : '<div style="color:var(--warn)">Nenhum canal — adicione WAPI_CHANNELS no Railway</div>';
    }
  } catch {}

  // Verifica status
  try {
    const r = await fetch('/api/whatsapp/status').then(res => res.json());
    if (r.connected) {
      const name = r.data?.name || r.data?.pushName || r.data?.phone || 'conectado';
      el.innerHTML = \`<span style="color:var(--accent)">✓ Conectado — \${name}</span>\`;
    } else {
      el.innerHTML = \`<span style="color:var(--warn)">✗ Desconectado\${r.error ? ' — ' + r.error : ''}</span>\`;
    }
  } catch {
    el.innerHTML = '<span style="color:var(--danger)">Erro ao verificar</span>';
  }
}

// ─── SETTINGS ─────────────────────────────────────────────────
function renderSettings() {
  document.getElementById('content').innerHTML = \`
    <div style="max-width:520px;">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:14px;">Variáveis de ambiente (.env)</div>
        <div style="font-size:12px;color:var(--muted);line-height:2.2;font-family:var(--mono);">
          <div><span style="color:var(--accent)">TELEGRAM_BOT_TOKEN</span>=seu_token_do_botfather</div>
          <div><span style="color:var(--accent)">TELEGRAM_CHANNEL_IDS</span>=-1001234567890,-1009876543210</div>
          <div><span style="color:var(--accent)">ML_AFFILIATE_TAG</span>=seutag-55</div>
          <div><span style="color:var(--accent)">MIN_DISCOUNT_PERCENT</span>=15</div>
          <div><span style="color:var(--accent)">SCRAPE_INTERVAL_MINUTES</span>=30</div>
          <div><span style="color:var(--accent)">SEARCH_KEYWORDS</span>=smartphone,notebook,tv</div>
          <div><span style="color:var(--accent)">ML_CATEGORIES</span>=eletronicos,informatica</div>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:14px;">Testar conexão</div>
        <button class="btn btn-green" onclick="testTelegram(this)">Testar bot Telegram</button>
        <button class="btn" style="margin-top:8px" onclick="testWhatsapp(this)">Testar WhatsApp</button>
        <div id="test-result" style="margin-top:10px;font-size:12px;font-family:var(--mono);color:var(--muted);"></div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Banco de dados</div>
        <div style="font-size:12px;color:var(--muted);">Localização: <code style="color:var(--text)">data/promobot.db</code></div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px;">Formato: SQLite via better-sqlite3</div>
      </div>
    </div>
  \`;
}

async function testWhatsapp(btn) {
  btn.innerHTML = '<div class="loader"></div> testando...';
  btn.disabled = true;
  const r = await fetch('/api/whatsapp/test').then(res => res.json());
  document.getElementById('test-result').textContent =
    r.ok ? '✓ WhatsApp conectado: ' + (r.phone?.display_phone_number || r.phone?.id) : '✗ Erro: ' + r.error;
  document.getElementById('test-result').style.color = r.ok ? 'var(--accent)' : 'var(--danger)';
  btn.innerHTML = 'Testar WhatsApp';
  btn.disabled = false;
}

async function testTelegram(btn) {
  btn.innerHTML = '<div class="loader"></div> testando...';
  btn.disabled = true;
  const r = await fetch('/api/telegram/test').then(res => res.json());
  document.getElementById('test-result').textContent =
    r.ok ? \`✓ Conectado: @\${r.bot?.username} (\${r.bot?.first_name})\` : \`✗ Erro: \${r.error}\`;
  document.getElementById('test-result').style.color = r.ok ? 'var(--accent)' : 'var(--danger)';
  btn.innerHTML = 'Testar bot Telegram';
  btn.disabled = false;
}

// ─── PROMO CARD RENDERER ──────────────────────────────────────
function renderPromoList(promos, showActions) {
  if (!promos.length) return '<div class="empty"><div class="empty-icon">📭</div>Nenhuma promoção encontrada</div>';

  return '<div class="promo-list">' + promos.map(p => {
    const badge = p.status === 'posted' ? 'badge-green" >✓ postado' :
                  p.status === 'pending' ? 'badge-warn">pendente' :
                  'badge-gray">ignorado';

    const thumb = p.image_url
      ? \`<img src="\${escHtml(p.image_url)}" onerror="this.parentElement.textContent='🏷'" />\`
      : '🏷';

    const discount = p.discount_percent ? \`<span class="badge badge-danger">-\${p.discount_percent}%</span>\` : '';

    const actions = showActions ? \`
      <div class="icon-btn green" title="Postar agora" onclick="postNow(\${p.id}, this)">▶</div>
      <div class="icon-btn danger" title="Ignorar" onclick="ignorePromo(\${p.id})">✕</div>
    \` : \`<div class="icon-btn" title="Abrir link" onclick="window.open('\${escHtml(p.affiliate_url)}','_blank')">↗</div>\`;

    return \`
      <div class="promo-card" id="promo-\${p.id}">
        <div class="promo-thumb">\${thumb}</div>
        <div class="promo-info">
          <div class="promo-title" title="\${escHtml(p.title)}">\${escHtml(p.title)}</div>
          <div class="promo-prices">
            <span class="promo-sale">\${fmtPrice(p.sale_price)}</span>
            \${p.original_price ? \`<span class="promo-original">\${fmtPrice(p.original_price)}</span>\` : ''}
            \${discount}
          </div>
          <div class="promo-meta">
            <span>\${p.category || 'geral'}</span>
            <span>•</span>
            <span>\${timeAgo(p.found_at)}</span>
            \${p.channel_names ? \`<span>• \${p.channel_names}</span>\` : ''}
          </div>
          <div class="promo-link">\${p.affiliate_url || ''}</div>
        </div>
        <div class="promo-actions">
          <span class="badge \${badge}</span>
          \${actions}
        </div>
      </div>
    \`;
  }).join('') + '</div>';
}

// ─── ACTIONS ──────────────────────────────────────────────────
async function postNow(id, btn) {
  btn.innerHTML = '<div class="loader"></div>';
  btn.disabled = true;
  const r = await fetch(\`/api/promotions/\${id}/post\`, { method: 'POST' }).then(res => res.json());
  if (r.success) {
    toast('Postado com sucesso!', 'success');
    document.getElementById(\`promo-\${id}\`)?.remove();
  } else {
    toast(r.reason || r.error || 'Erro ao postar', 'error');
    btn.innerHTML = '▶';
    btn.disabled = false;
  }
}

async function ignorePromo(id) {
  await fetch(\`/api/promotions/\${id}/ignore\`, { method: 'POST' });
  document.getElementById(\`promo-\${id}\`)?.remove();
  toast('Promoção ignorada', 'success');
}

async function forceScrape(btn) {
  btn.innerHTML = '<div class="loader"></div> buscando...';
  btn.disabled = true;
  const r = await fetch('/api/scrape', { method: 'POST' }).then(res => res.json());
  toast(r.message || r.error, r.error ? 'error' : 'success');
  setTimeout(() => { btn.innerHTML = '<span>↻</span> Buscar agora'; btn.disabled = false; }, 2000);
}

// ─── MODAL ────────────────────────────────────────────────────
function openModal() {
  document.getElementById('channel-modal').classList.add('show');
  document.getElementById('ch-id').focus();
}

function closeModal() {
  document.getElementById('channel-modal').classList.remove('show');
}

async function saveChannel() {
  const id = document.getElementById('ch-id').value.trim();
  const name = document.getElementById('ch-name').value.trim();
  const filter = document.getElementById('ch-filter').value.trim();
  if (!id || !name) { toast('Preencha ID e nome do canal', 'error'); return; }
  await fetch('/api/channels', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ telegram_id: id, name, category_filter: filter }) });
  closeModal();
  toast('Canal adicionado!', 'success');
  renderChannels();
}

document.getElementById('channel-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

// ─── UTILS ────────────────────────────────────────────────────
function fmtPrice(v) {
  if (!v) return '–';
  return 'R$ ' + parseFloat(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return Math.floor(diff/60) + 'min atrás';
  if (diff < 86400) return Math.floor(diff/3600) + 'h atrás';
  return Math.floor(diff/86400) + 'd atrás';
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = type === 'success' ? '✓ ' + msg : '✕ ' + msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── INIT ─────────────────────────────────────────────────────
render('dashboard');
updateStatus();
setInterval(updateStatus, 10000);
setInterval(() => { if (currentPage === 'dashboard') renderDashboard(); }, 30000);
</script>
</body>
</html>`;

function startWebServer() {
  const port = process.env.WEB_PORT || 3000;
  app.listen(port, () => {
    console.log(`[Web] Painel disponível em: http://localhost:${port}`);
  });
  return app;
}

module.exports = { startWebServer, app };
