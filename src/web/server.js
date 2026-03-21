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
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'authorization_code', client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_APP_SECRET, code, redirect_uri: process.env.APP_URL + '/ml/callback',
    });
    process.env.ML_ACCESS_TOKEN = response.data.access_token;
    process.env.ML_REFRESH_TOKEN = response.data.refresh_token;
    scheduleTokenRefresh(response.data.expires_in);
    res.send('<html><body><h2 style="color:#1D9E75">Token obtido!</h2><a href="/">Voltar</a></body></html>');
  } catch (err) {
    res.send('<h2>Erro ao obter token</h2>');
  }
});

function scheduleTokenRefresh(expiresInSeconds) {
  setTimeout(async () => {
    try {
      const r = await axios.post('https://api.mercadolibre.com/oauth/token', {
        grant_type: 'refresh_token', client_id: process.env.ML_APP_ID,
        client_secret: process.env.ML_APP_SECRET, refresh_token: process.env.ML_REFRESH_TOKEN,
      });
      process.env.ML_ACCESS_TOKEN = r.data.access_token;
      process.env.ML_REFRESH_TOKEN = r.data.refresh_token;
      scheduleTokenRefresh(r.data.expires_in);
    } catch (err) { console.error('[ML Auth] Erro renovacao:', err.message); }
  }, Math.max((expiresInSeconds - 300), 60) * 1000);
}

// API ROUTES
app.get('/api/stats', (req, res) => res.json({ ...getStats(), scheduler: getStatus() }));
app.get('/api/history', (req, res) => res.json(getHistory(parseInt(req.query.limit)||50, parseInt(req.query.offset)||0)));
app.get('/api/pending', (req, res) => res.json(getPendingPromotions()));
app.get('/api/channels', (req, res) => res.json(getChannels()));
app.post('/api/channels', (req, res) => {
  const { telegram_id, name, category_filter } = req.body;
  if (!telegram_id || !name) return res.status(400).json({ error: 'telegram_id e name obrigatorios' });
  saveChannel({ telegram_id, name, category_filter: category_filter || null, active: 1 });
  res.json({ ok: true });
});
app.patch('/api/channels/:id/toggle', (req, res) => { toggleChannel(parseInt(req.params.id)); res.json({ ok: true }); });

app.post('/api/promotions/:id/post', async (req, res) => {
  const promo = getPendingPromotions().find(p => p.id === parseInt(req.params.id));
  if (!promo) return res.status(404).json({ error: 'Nao encontrada' });
  const result = await sendPromotion(promo);
  if (result.success) markAsPosted(promo.id);
  res.json(result);
});
app.post('/api/promotions/:id/ignore', (req, res) => { markAsIgnored(parseInt(req.params.id)); res.json({ ok: true }); });
app.get('/api/promotions/:id/preview', (req, res) => {
  const promo = [...getPendingPromotions(), ...getHistory(200,0)].find(p => p.id === parseInt(req.params.id));
  if (!promo) return res.status(404).json({ error: 'Nao encontrada' });
  res.json({ message: buildMessage(promo) });
});
app.post('/api/scrape', async (req, res) => {
  if (getStatus().isRunning) return res.status(409).json({ error: 'Ja em andamento' });
  res.json({ ok: true, message: 'Scraping iniciado' });
  runScrapeAndPost();
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

app.get('/api/sources', (req, res) => res.json(getSources()));
app.patch('/api/sources/:id/toggle', (req, res) => { toggleSource(req.params.id); res.json({ ok: true }); });

app.get('/api/whatsapp/qrcode', async (req, res) => {
  const { WAPI_INSTANCE_ID: id, WAPI_TOKEN: token } = process.env;
  if (!id || !token) return res.status(400).json({ error: 'WAPI nao configurado' });
  try {
    const resp = await axios.get(`https://api.w-api.app/v1/instance/qr-code?instanceId=${id}&image=enable`,
      { headers: { 'Authorization': 'Bearer ' + token }, responseType: 'arraybuffer', timeout: 15000 });
    const ct = resp.headers['content-type'] || 'image/png';
    res.json({ base64: `data:${ct};base64,${Buffer.from(resp.data).toString('base64')}` });
  } catch (err) {
    try {
      const r2 = await axios.get(`https://api.w-api.app/v1/instance/qr-code?instanceId=${id}&image=enable`,
        { headers: { 'Authorization': 'Bearer ' + token }, timeout: 15000 });
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
    const resp = await axios.get(`https://api.w-api.app/v1/instance/status-instance?instanceId=${id}`,
      { headers: { 'Authorization': 'Bearer ' + token }, timeout: 10000 });
    res.json({ connected: resp.data.connected === true, data: resp.data });
  } catch (err) { res.json({ connected: false, error: err.message }); }
});

app.get('/api/whatsapp/test', async (req, res) => {
  const { testConnection: waTest } = require('../bot/whatsapp');
  res.json(await waTest());
});

app.get('/api/telegram/test', async (req, res) => res.json(await testConnection()));
app.get('/api/status', (req, res) => res.json(getStatus()));

app.get('/', (req, res) => res.send(HTML_DASHBOARD));

const HTML_DASHBOARD = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PromoBot</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0d0e10;--surface:#16181c;--surface2:#1e2026;--border:#2a2d35;--text:#e8eaf0;--muted:#6b7280;--accent:#00c853;--accent-dim:#003d19;--warn:#ff9100;--warn-dim:#3d2400;--danger:#ff4444;--info:#3b82f6;--info-dim:#0f1f3d;--mono:'DM Mono',monospace;--sans:'DM Sans',sans-serif;--radius:10px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:var(--bg);color:var(--text);min-height:100vh;font-size:14px}
.app{display:flex;min-height:100vh}
.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;position:fixed;top:0;left:0;height:100vh;z-index:100}
.main{margin-left:220px;flex:1;display:flex;flex-direction:column}
.topbar{padding:16px 28px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50}
.content{padding:24px 28px;flex:1}
.logo{padding:20px 18px 16px;border-bottom:1px solid var(--border)}
.logo-title{font-size:17px;font-weight:600;color:var(--accent)}
.logo-sub{font-size:11px;color:var(--muted);margin-top:2px;font-family:var(--mono)}
.nav{padding:10px 8px;flex:1}
.nav-label{font-size:10px;color:var(--muted);padding:8px 8px 4px;text-transform:uppercase;letter-spacing:1px}
.nav-item{display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:8px;cursor:pointer;color:var(--muted);font-size:13px;margin-bottom:1px;transition:all 0.15s;border:1px solid transparent}
.nav-item:hover{background:var(--surface2);color:var(--text)}
.nav-item.active{background:var(--accent-dim);color:var(--accent);border-color:#00c85330;font-weight:500}
.nav-icon{font-size:15px;width:18px;text-align:center}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);margin-left:auto;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.page-title{font-size:16px;font-weight:600}
.btn{padding:8px 16px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-family:var(--sans);font-weight:500;transition:all 0.15s;display:inline-flex;align-items:center;gap:6px}
.btn:hover{border-color:#444;background:#2a2d35}
.btn:active{transform:scale(0.97)}
.btn-green{background:var(--accent);color:#000;border-color:var(--accent)}
.btn-green:hover{background:#00e060}
.btn-row{display:flex;gap:8px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
.stat-value{font-size:28px;font-weight:600;font-family:var(--mono);color:var(--text)}
.stat-sub{font-size:11px;color:var(--accent);margin-top:4px}
.stat.warn .stat-value{color:var(--warn)}
.stat.green .stat-value{color:var(--accent)}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.section-title{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px}
.badge{font-size:11px;padding:3px 9px;border-radius:20px;font-weight:500;font-family:var(--mono);display:inline-flex;align-items:center;gap:4px}
.badge-green{background:var(--accent-dim);color:var(--accent)}
.badge-warn{background:var(--warn-dim);color:var(--warn)}
.badge-gray{background:var(--surface2);color:var(--muted);border:1px solid var(--border)}
.badge-info{background:var(--info-dim);color:var(--info)}
.badge-danger{background:#3d0000;color:var(--danger)}
.promo-list{display:flex;flex-direction:column;gap:8px}
.promo-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;display:flex;gap:14px;align-items:flex-start;transition:border-color 0.15s}
.promo-card:hover{border-color:#3a3d45}
.promo-thumb{width:56px;height:56px;border-radius:8px;background:var(--surface2);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:24px;border:1px solid var(--border);overflow:hidden}
.promo-thumb img{width:100%;height:100%;object-fit:cover}
.promo-info{flex:1;min-width:0}
.promo-title{font-size:13px;font-weight:500;color:var(--text);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.promo-prices{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.promo-sale{font-size:15px;font-weight:600;color:var(--accent);font-family:var(--mono)}
.promo-original{font-size:12px;color:var(--muted);text-decoration:line-through;font-family:var(--mono)}
.promo-meta{font-size:11px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap}
.promo-link{font-size:11px;color:var(--info);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.promo-actions{display:flex;gap:6px;align-items:flex-start;flex-shrink:0;padding-top:2px}
.icon-btn{width:30px;height:30px;border-radius:7px;border:1px solid var(--border);background:var(--surface2);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;transition:all 0.15s}
.icon-btn:hover{background:var(--surface);border-color:#444}
.icon-btn.green:hover{border-color:var(--accent);color:var(--accent)}
.icon-btn.danger:hover{border-color:var(--danger);color:var(--danger)}
.channels-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.channel-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.channel-name{font-size:14px;font-weight:500;display:flex;align-items:center;gap:8px;margin-bottom:6px}
.channel-id{font-size:11px;color:var(--muted);font-family:var(--mono)}
.channel-footer{display:flex;align-items:center;justify-content:space-between;margin-top:12px}
.toggle{width:36px;height:20px;border-radius:10px;background:var(--muted);position:relative;transition:background 0.2s;cursor:pointer}
.toggle.on{background:var(--accent)}
.toggle::after{content:'';width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:2px;transition:transform 0.2s}
.toggle.on::after{transform:translateX(16px)}
.add-channel-card{border:1px dashed var(--border);background:transparent;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--muted);font-size:13px;min-height:120px}
.add-channel-card:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity 0.2s}
.modal-overlay.show{opacity:1;pointer-events:all}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px;width:420px;max-width:90vw}
.modal-title{font-size:16px;font-weight:600;margin-bottom:18px}
.field{margin-bottom:14px}
.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px}
.field input,.field select{width:100%;padding:9px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--sans);font-size:13px;outline:none;transition:border-color 0.15s}
.field input:focus,.field select:focus{border-color:var(--accent)}
.status-bar{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--muted);font-family:var(--mono)}
.status-indicator{display:flex;align-items:center;gap:5px}
.indicator-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.indicator-dot.off{background:var(--muted)}
.indicator-dot.running{background:var(--warn);animation:pulse 1s infinite}
.tabs{display:flex;gap:2px;background:var(--surface2);border-radius:9px;padding:3px;margin-bottom:18px;width:fit-content}
.tab{padding:6px 16px;border-radius:7px;font-size:13px;cursor:pointer;color:var(--muted);font-weight:500;transition:all 0.15s}
.tab.active{background:var(--surface);color:var(--text)}
.toast{position:fixed;bottom:24px;right:24px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 18px;font-size:13px;z-index:9999;transform:translateY(80px);opacity:0;transition:all 0.3s;max-width:320px}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{border-color:var(--accent)}
.toast.error{border-color:var(--danger)}
.loader{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:40px;color:var(--muted);font-size:13px}
.empty-icon{font-size:32px;margin-bottom:10px}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.sources-grid{display:flex;flex-direction:column;gap:10px}
.source-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;transition:border-color 0.15s}
.source-card.active{border-color:#1D9E7540}
.source-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.source-name{font-size:13px;font-weight:500;color:var(--text)}
.source-desc{font-size:11px;color:var(--muted);margin-top:2px}
.source-footer{display:flex;align-items:center;justify-content:space-between;gap:8px}
.source-cred{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.source-cred code{font-family:var(--mono);font-size:11px;background:var(--surface2);padding:2px 7px;border-radius:5px;color:var(--accent)}
@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}.channels-grid{grid-template-columns:1fr 1fr}.sidebar{width:180px}.main{margin-left:180px}}
</style>
</head>
<body>
<div class="app">
  <div class="sidebar">
    <div class="logo">
      <div class="logo-title">⚡ PromoBot</div>
      <div class="logo-sub">rakuten + shopee + telegram</div>
    </div>
    <div class="nav">
      <div class="nav-label">Menu</div>
      <div class="nav-item active" onclick="navigate('dashboard',this)"><span class="nav-icon">◈</span> Dashboard <span class="status-dot" id="running-dot" style="display:none"></span></div>
      <div class="nav-item" onclick="navigate('pending',this)"><span class="nav-icon">◷</span> Pendentes <span id="pending-count" style="margin-left:auto;font-size:10px;"></span></div>
      <div class="nav-item" onclick="navigate('history',this)"><span class="nav-icon">◎</span> Histórico</div>
      <div class="nav-item" onclick="navigate('channels',this)"><span class="nav-icon">◉</span> Canais</div>
      <div class="nav-item" onclick="navigate('sources',this)"><span class="nav-icon">◍</span> Fontes</div>
      <div class="nav-item" onclick="navigate('manual',this)"><span class="nav-icon">✚</span> Nova promo</div>
      <div class="nav-label">Sistema</div>
      <div class="nav-item" onclick="navigate('whatsapp',this)"><span class="nav-icon">◌</span> WhatsApp</div>
      <div class="nav-item" onclick="navigate('settings',this)"><span class="nav-icon">◐</span> Configuração</div>
    </div>
  </div>
  <div class="main">
    <div class="topbar">
      <div class="page-title" id="page-title">Dashboard</div>
      <div class="btn-row">
        <div class="status-bar"><div class="status-indicator"><div class="indicator-dot" id="status-dot"></div><span id="status-text">verificando...</span></div></div>
        <button class="btn" onclick="forceScrape(this)"><span>↻</span> Buscar agora</button>
      </div>
    </div>
    <div class="content" id="content"><div class="empty"><div class="loader"></div></div></div>
  </div>
</div>

<div class="modal-overlay" id="channel-modal">
  <div class="modal">
    <div class="modal-title">Adicionar canal Telegram</div>
    <div class="field"><label>ID do Canal</label><input type="text" id="ch-id" placeholder="-1001234567890" /></div>
    <div class="field"><label>Nome do canal</label><input type="text" id="ch-name" placeholder="Ex: Promos Tech BR" /></div>
    <div class="field"><label>Filtro (opcional)</label><input type="text" id="ch-filter" placeholder="smartphone,notebook,tv" /></div>
    <div class="btn-row" style="justify-content:flex-end;margin-top:6px;">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-green" onclick="saveChannel()">Salvar canal</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
var currentPage = 'dashboard';

function navigate(page, el) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(function(e){ e.classList.remove('active'); });
  if (el) el.classList.add('active');
  var titles = {dashboard:'Dashboard',pending:'Pendentes',history:'Historico',channels:'Canais',sources:'Fontes',manual:'Nova promocao',whatsapp:'WhatsApp',settings:'Configuracao'};
  document.getElementById('page-title').textContent = titles[page] || page;
  render(page);
}

function render(page) {
  document.getElementById('content').innerHTML = '<div class="empty"><div class="loader"></div></div>';
  if (page === 'dashboard') renderDashboard();
  else if (page === 'pending') renderPending();
  else if (page === 'history') renderHistory();
  else if (page === 'channels') renderChannels();
  else if (page === 'sources') renderSources();
  else if (page === 'manual') renderManual();
  else if (page === 'whatsapp') renderWhatsApp();
  else if (page === 'settings') renderSettings();
}

function updateStatus() {
  fetch('/api/status').then(function(r){ return r.json(); }).then(function(s) {
    var dot = document.getElementById('status-dot');
    var txt = document.getElementById('status-text');
    var rd  = document.getElementById('running-dot');
    if (s.isRunning) {
      dot.className = 'indicator-dot running'; txt.textContent = 'buscando...';
      if (rd) rd.style.display = '';
    } else {
      dot.className = 'indicator-dot';
      var next = s.nextRunAt ? new Date(s.nextRunAt) : null;
      txt.textContent = next ? 'proxima: ' + next.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : 'aguardando';
      if (rd) rd.style.display = 'none';
    }
  }).catch(function(){});
}

function renderDashboard() {
  Promise.all([
    fetch('/api/stats').then(function(r){return r.json();}),
    fetch('/api/history?limit=10').then(function(r){return r.json();})
  ]).then(function(results) {
    var s = results[0]; var history = results[1];
    var pc = document.getElementById('pending-count');
    if (pc) pc.textContent = s.pending > 0 ? s.pending : '';
    document.getElementById('content').innerHTML =
      '<div class="stats">' +
        '<div class="stat green"><div class="stat-label">Postadas hoje</div><div class="stat-value">' + s.today + '</div></div>' +
        '<div class="stat"><div class="stat-label">Total postadas</div><div class="stat-value">' + s.posted + '</div></div>' +
        '<div class="stat warn"><div class="stat-label">Pendentes</div><div class="stat-value">' + s.pending + '</div></div>' +
        '<div class="stat"><div class="stat-label">Desconto medio</div><div class="stat-value">' + s.avgDiscount + '%</div></div>' +
      '</div>' +
      '<div class="section-header"><div class="section-title">Ultimas promocoes</div></div>' +
      renderPromoList(history.slice(0, 8), false);
  });
}

function renderPending() {
  fetch('/api/pending').then(function(r){return r.json();}).then(function(data) {
    document.getElementById('content').innerHTML =
      '<div class="section-header"><div class="section-title">Aguardando postagem</div><span class="badge badge-warn">' + data.length + ' pendentes</span></div>' +
      (data.length === 0 ? '<div class="empty"><div class="empty-icon">✓</div>Nenhuma pendente</div>' : renderPromoList(data, true));
  });
}

var histTab = 'all';
function renderHistory() {
  fetch('/api/history?limit=50').then(function(r){return r.json();}).then(function(data) {
    var filtered = histTab === 'all' ? data : histTab === 'posted' ? data.filter(function(p){return p.status==='posted';}) : data.filter(function(p){return p.status!=='posted';});
    document.getElementById('content').innerHTML =
      '<div class="tabs">' +
        '<div class="tab ' + (histTab==='all'?'active':'') + '" onclick="setHistTab(\'all\')">Todos</div>' +
        '<div class="tab ' + (histTab==='posted'?'active':'') + '" onclick="setHistTab(\'posted\')">Postados</div>' +
        '<div class="tab ' + (histTab==='other'?'active':'') + '" onclick="setHistTab(\'other\')">Outros</div>' +
      '</div>' +
      (filtered.length === 0 ? '<div class="empty"><div class="empty-icon">📋</div>Nenhuma</div>' : renderPromoList(filtered, false));
  });
}
function setHistTab(tab) { histTab = tab; renderHistory(); }

function renderChannels() {
  fetch('/api/channels').then(function(r){return r.json();}).then(function(data) {
    var cards = data.map(function(c) {
      return '<div class="channel-card" id="ch-' + c.id + '">' +
        '<div class="channel-name"><span>' + (c.active ? '🟢' : '⚫') + '</span> ' + escHtml(c.name) + '</div>' +
        '<div class="channel-id">' + c.telegram_id + '</div>' +
        (c.category_filter ? '<div style="font-size:11px;color:var(--info);margin-top:4px">filtro: ' + escHtml(c.category_filter) + '</div>' : '') +
        '<div class="channel-footer">' +
          '<span class="badge ' + (c.active ? 'badge-green' : 'badge-gray') + '">' + (c.active ? 'ativo' : 'pausado') + '</span>' +
          '<div class="toggle ' + (c.active ? 'on' : '') + '" onclick="toggleCh(' + c.id + ')"></div>' +
        '</div></div>';
    }).join('');
    document.getElementById('content').innerHTML =
      '<div class="section-header"><div class="section-title">Canais</div></div>' +
      '<div class="channels-grid">' + cards +
        '<div class="channel-card add-channel-card" onclick="openModal()"><div style="font-size:24px">+</div><div>Adicionar canal</div></div>' +
      '</div>';
  });
}
function toggleCh(id) {
  fetch('/api/channels/' + id + '/toggle', {method:'PATCH'}).then(function(){ renderChannels(); toast('Canal atualizado','success'); });
}

function renderSources() {
  fetch('/api/sources').then(function(r){return r.json();}).then(function(data) {
    var info = {
      shopee:   {icon:'🧡', label:'Shopee', desc:'API afiliados Shopee', cred:'SHOPEE_APP_ID + SHOPEE_SECRET', link:'https://affiliate.shopee.com.br'},
      shopee_kw:{icon:'🔎', label:'Shopee keywords', desc:'Busca por keyword', cred:'SHOPEE_APP_ID + SHOPEE_SECRET', link:'https://affiliate.shopee.com.br'},
      rakuten:  {icon:'🏪', label:'Rakuten Coupon Feed', desc:'Netshoes, Americanas e +50 lojas', cred:'RAKUTEN_WS_TOKEN', link:'https://publisher.rakutenadvertising.com'},
    };
    var cards = data.map(function(s) {
      var i = info[s.id] || {icon:'◉', label:s.name, desc:'', cred:''};
      var lr = s.last_run ? timeAgo(s.last_run) : 'nunca';
      return '<div class="source-card ' + (s.active ? 'active' : '') + '">' +
        '<div class="source-head"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:22px">' + i.icon + '</span>' +
          '<div><div class="source-name">' + i.label + '</div><div class="source-desc">' + i.desc + '</div></div></div>' +
          '<div class="toggle ' + (s.active ? 'on' : '') + '" onclick="toggleSrc(\'' + s.id + '\',this)"></div></div>' +
        '<div class="source-footer">' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<span class="badge ' + (s.active ? 'badge-green' : 'badge-gray') + '">' + (s.active ? 'ativo' : 'inativo') + '</span>' +
            (s.last_count > 0 ? '<span class="badge badge-info">' + s.last_count + ' promos</span>' : '') +
            '<span style="font-size:11px;color:var(--muted)">' + lr + '</span>' +
          '</div>' +
          (i.link ? '<a href="' + i.link + '" target="_blank" style="font-size:11px;color:var(--info)">Cadastrar →</a>' : '') +
        '</div></div>';
    }).join('');
    document.getElementById('content').innerHTML =
      '<div class="section-header"><div class="section-title">Fontes</div><button class="btn" style="font-size:12px;padding:4px 10px" onclick="forceScrape(this)">↻ Buscar agora</button></div>' +
      '<div class="sources-grid">' + cards + '</div>';
  });
}
function toggleSrc(id, el) {
  fetch('/api/sources/' + id + '/toggle', {method:'PATCH'}).then(function(){
    el.classList.toggle('on');
    var card = el.closest('.source-card'); card.classList.toggle('active');
    var badge = card.querySelector('.badge'); var on = el.classList.contains('on');
    badge.className = 'badge ' + (on ? 'badge-green' : 'badge-gray');
    badge.textContent = on ? 'ativo' : 'inativo';
    toast(on ? 'Fonte ativada' : 'Fonte desativada', 'success');
  });
}

function renderManual() {
  var h = '<div style="max-width:520px">';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px">';
  h += '<div style="font-size:13px;font-weight:600;margin-bottom:16px">Cadastrar promoção manualmente</div>';
  h += '<div class="field"><label>Título *</label><input type="text" id="m-title" placeholder="Ex: Nike Air Max 270" /></div>';
  h += '<div class="field"><label>Link de afiliado *</label><input type="text" id="m-url" placeholder="https://..." /></div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += '<div class="field"><label>Preço com desconto (R$)</label><input type="number" id="m-sale" placeholder="199.90" step="0.01" /></div>';
  h += '<div class="field"><label>Preço original (R$)</label><input type="number" id="m-original" placeholder="299.90" step="0.01" /></div>';
  h += '</div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += '<div class="field"><label>Loja</label><input type="text" id="m-seller" placeholder="Ex: Netshoes" /></div>';
  h += '<div class="field"><label>Código do cupom</label><input type="text" id="m-coupon" placeholder="Ex: PROMO10" /></div>';
  h += '</div>';
  h += '<div class="field"><label>URL da imagem (opcional)</label><input type="text" id="m-image" placeholder="https://..." /></div>';
  h += '<div id="m-preview" style="display:none;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin:12px 0;font-size:12px;font-family:var(--mono);white-space:pre-wrap;line-height:1.6"></div>';
  h += '<div style="display:flex;gap:8px;margin-top:4px">';
  h += '<button class="btn" onclick="previewManual()">👁 Prévia</button>';
  h += '<button class="btn btn-green" onclick="submitManual(this)">✚ Adicionar à fila</button>';
  h += '</div></div>';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;font-size:12px;color:var(--muted)">';
  h += '<div style="font-weight:600;color:var(--text);margin-bottom:6px">Como funciona</div>';
  h += '<div>A promoção entra na fila e é postada automaticamente. Para postar imediatamente, vá em <strong style="color:var(--text)">Pendentes</strong> e clique em ▶.</div>';
  h += '</div></div>';
  document.getElementById('content').innerHTML = h;
}

function previewManual() {
  var title    = document.getElementById('m-title').value.trim();
  var url      = document.getElementById('m-url').value.trim() || 'https://...';
  var sale     = parseFloat(document.getElementById('m-sale').value) || 0;
  var original = parseFloat(document.getElementById('m-original').value) || 0;
  var seller   = document.getElementById('m-seller').value.trim() || 'loja parceira';
  var coupon   = document.getElementById('m-coupon').value.trim();
  if (!title) { toast('Preencha o titulo', 'error'); return; }
  var discount = 0;
  if (original > sale && sale > 0) discount = Math.round(((original - sale) / original) * 100);
  var fire = discount >= 50 ? '🚨🔥' : discount >= 30 ? '💥' : '🔥';
  var lines = [fire + ' ' + title, ''];
  if (original && sale) {
    lines.push('💰 De: R$ ' + original.toFixed(2).replace('.',','));
    lines.push('🏷 Por: R$ ' + sale.toFixed(2).replace('.',',') + (discount ? '  ✅ -' + discount + '% OFF' : ''));
    lines.push('');
  } else if (discount) {
    lines.push('✅ ' + discount + '% de desconto!', '');
  }
  if (coupon) { lines.push('🎟 Cupom: ' + coupon, ''); }
  lines.push('━━━━━━━━━━━━━━━━━━', '🛒 Comprar na ' + seller + ':', url, '', '⏳ Oferta por tempo limitado!');
  var box = document.getElementById('m-preview');
  box.style.display = '';
  box.textContent = lines.join('\n');
}

function submitManual(btn) {
  var title    = document.getElementById('m-title').value.trim();
  var url      = document.getElementById('m-url').value.trim();
  var sale     = document.getElementById('m-sale').value;
  var original = document.getElementById('m-original').value;
  var seller   = document.getElementById('m-seller').value.trim();
  var coupon   = document.getElementById('m-coupon').value.trim();
  var image    = document.getElementById('m-image').value.trim();
  if (!title) { toast('Titulo e obrigatorio', 'error'); return; }
  if (!url)   { toast('Link e obrigatorio', 'error'); return; }
  btn.innerHTML = '<div class="loader"></div> salvando...';
  btn.disabled = true;
  fetch('/api/promotions/manual', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ title: title, affiliate_url: url, sale_price: sale, original_price: original,
      seller: seller, extra_info: coupon ? 'Cupom: ' + coupon : null, image_url: image || null })
  }).then(function(r){return r.json();}).then(function(r) {
    if (r.ok) {
      toast('Promocao adicionada a fila!', 'success');
      ['m-title','m-url','m-sale','m-original','m-seller','m-coupon','m-image'].forEach(function(id){ document.getElementById(id).value = ''; });
      document.getElementById('m-preview').style.display = 'none';
    } else { toast(r.error || 'Erro ao salvar', 'error'); }
    btn.innerHTML = '✚ Adicionar a fila'; btn.disabled = false;
  });
}

function renderWhatsApp() {
  var h = '<div style="max-width:480px">';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px">';
  h += '<div style="font-size:13px;font-weight:600;margin-bottom:6px">Status da conexão</div>';
  h += '<div id="wa-status" style="font-size:12px;color:var(--muted)">Verificando...</div>';
  h += '<div style="margin-top:12px;display:flex;gap:8px">';
  h += '<button class="btn btn-green" onclick="loadQR(this)">📱 Gerar QR Code</button>';
  h += '<button class="btn" onclick="checkWaStatus()">↻ Verificar status</button>';
  h += '</div></div>';
  h += '<div id="qr-box" style="display:none;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;text-align:center;margin-bottom:14px">';
  h += '<div style="font-size:13px;font-weight:600;margin-bottom:12px">Escaneie com seu WhatsApp</div>';
  h += '<div id="qr-content" style="min-height:200px;display:flex;align-items:center;justify-content:center"><div class="loader"></div></div>';
  h += '<div style="font-size:11px;color:var(--muted);margin-top:10px">WhatsApp → Dispositivos conectados → Conectar dispositivo</div>';
  h += '<div style="margin-top:10px;display:flex;gap:8px;justify-content:center">';
  h += '<button class="btn" onclick="loadQR(this)">↻ Atualizar QR</button>';
  h += '<button class="btn" onclick="document.getElementById(\'qr-box\').style.display=\'none\'">Fechar</button>';
  h += '</div></div>';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px">';
  h += '<div style="font-size:13px;font-weight:600;margin-bottom:8px">Canais configurados</div>';
  h += '<div id="wa-channels" style="font-size:12px;color:var(--muted);line-height:2;font-family:var(--mono)">Carregando...</div>';
  h += '</div>';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px">';
  h += '<div style="font-size:13px;font-weight:600;margin-bottom:8px">Como conectar</div>';
  h += '<ol style="font-size:12px;color:var(--muted);padding-left:16px;line-height:2.2">';
  h += '<li>Clique em <strong style="color:var(--text)">Gerar QR Code</strong></li>';
  h += '<li>Abra o WhatsApp no celular</li>';
  h += '<li>Toque em <strong style="color:var(--text)">Dispositivos conectados</strong></li>';
  h += '<li>Toque em <strong style="color:var(--text)">Conectar dispositivo</strong></li>';
  h += '<li>Escaneie o QR code</li></ol>';
  h += '<div style="margin-top:10px;font-size:11px;color:var(--muted)">';
  h += 'Variaveis no Railway:<br>';
  h += '<code style="color:var(--accent)">WAPI_INSTANCE_ID</code>, ';
  h += '<code style="color:var(--accent)">WAPI_TOKEN</code>, ';
  h += '<code style="color:var(--accent)">WAPI_CHANNELS</code>';
  h += '</div></div></div>';
  document.getElementById('content').innerHTML = h;
  checkWaStatus();
}

function loadQR(btn) {
  btn.innerHTML = '<div class="loader"></div>';
  btn.disabled = true;
  document.getElementById('qr-box').style.display = '';
  document.getElementById('qr-content').innerHTML = '<div class="loader"></div>';
  fetch('/api/whatsapp/qrcode').then(function(r){return r.json();}).then(function(r) {
    if (r.error) {
      document.getElementById('qr-content').innerHTML = '<div style="color:var(--danger);font-size:13px">' + r.error + '</div>';
    } else if (r.base64) {
      document.getElementById('qr-content').innerHTML = '<img src="' + r.base64 + '" style="max-width:240px;border-radius:8px">';
    } else if (r.qrcode || r.qr || r.image || r.value) {
      var img = r.qrcode || r.qr || r.image || r.value;
      var src = img.startsWith('data:') ? img : 'data:image/png;base64,' + img;
      document.getElementById('qr-content').innerHTML = '<img src="' + src + '" style="max-width:240px;border-radius:8px">';
    } else {
      document.getElementById('qr-content').innerHTML = '<pre style="font-size:10px;color:var(--text);text-align:left">' + JSON.stringify(r,null,2).substring(0,500) + '</pre>';
    }
    btn.innerHTML = '📱 Gerar QR Code'; btn.disabled = false;
  }).catch(function(err) {
    document.getElementById('qr-content').innerHTML = '<div style="color:var(--danger)">Erro: ' + err.message + '</div>';
    btn.innerHTML = '📱 Gerar QR Code'; btn.disabled = false;
  });
}

function checkWaStatus() {
  var el = document.getElementById('wa-status');
  if (!el) return;
  el.textContent = 'Verificando...';
  fetch('/api/whatsapp/channels').then(function(r){return r.json();}).then(function(ch) {
    var chEl = document.getElementById('wa-channels');
    if (chEl) chEl.innerHTML = ch.channels.length ? ch.channels.map(function(c){return '<div>'+c+'</div>';}).join('') : '<div style="color:var(--warn)">Nenhum canal configurado</div>';
  }).catch(function(){});
  fetch('/api/whatsapp/status').then(function(r){return r.json();}).then(function(r) {
    if (r.connected) {
      var id = (r.data && r.data.instanceId) ? ' — ' + r.data.instanceId : '';
      el.innerHTML = '<span style="color:var(--accent)">✓ Conectado' + id + '</span>';
    } else {
      el.innerHTML = '<span style="color:var(--warn)">✗ Desconectado' + (r.error ? ' — ' + r.error : '') + '</span>';
    }
  }).catch(function(){ el.innerHTML = '<span style="color:var(--danger)">Erro ao verificar</span>'; });
}

function renderSettings() {
  var h = '<div style="max-width:520px">';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px">';
  h += '<div style="font-size:13px;font-weight:600;margin-bottom:14px">Testar conexão</div>';
  h += '<button class="btn btn-green" onclick="testTelegram(this)">Testar bot Telegram</button> ';
  h += '<button class="btn" onclick="testWhatsapp(this)" style="margin-left:8px">Testar WhatsApp</button>';
  h += '<div id="test-result" style="margin-top:10px;font-size:12px;font-family:var(--mono);color:var(--muted)"></div>';
  h += '</div>';
  h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px">';
  h += '<div style="font-size:13px;font-weight:600;margin-bottom:8px">Banco de dados</div>';
  h += '<div style="font-size:12px;color:var(--muted)">Localização: <code style="color:var(--text)">data/promobot.db</code></div>';
  h += '</div></div>';
  document.getElementById('content').innerHTML = h;
}

function testWhatsapp(btn) {
  btn.innerHTML = '<div class="loader"></div> testando...'; btn.disabled = true;
  fetch('/api/whatsapp/test').then(function(r){return r.json();}).then(function(r) {
    var el = document.getElementById('test-result');
    el.textContent = r.ok ? '✓ WhatsApp conectado' : '✗ Erro: ' + r.error;
    el.style.color = r.ok ? 'var(--accent)' : 'var(--danger)';
    btn.innerHTML = 'Testar WhatsApp'; btn.disabled = false;
  });
}

function testTelegram(btn) {
  btn.innerHTML = '<div class="loader"></div> testando...'; btn.disabled = true;
  fetch('/api/telegram/test').then(function(r){return r.json();}).then(function(r) {
    var el = document.getElementById('test-result');
    el.textContent = r.ok ? '✓ Conectado: @' + (r.bot && r.bot.username) : '✗ Erro: ' + r.error;
    el.style.color = r.ok ? 'var(--accent)' : 'var(--danger)';
    btn.innerHTML = 'Testar bot Telegram'; btn.disabled = false;
  });
}

function renderPromoList(promos, showActions) {
  if (!promos.length) return '<div class="empty"><div class="empty-icon">📭</div>Nenhuma promocao encontrada</div>';
  return '<div class="promo-list">' + promos.map(function(p) {
    var badge = p.status === 'posted' ? 'badge-green">✓ postado' : p.status === 'pending' ? 'badge-warn">pendente' : 'badge-gray">ignorado';
    var thumb = p.image_url ? '<img src="' + escHtml(p.image_url) + '" onerror="this.parentElement.textContent=\'🏷\'" />' : '🏷';
    var discount = p.discount_percent ? '<span class="badge badge-danger">-' + p.discount_percent + '%</span>' : '';
    var actions = showActions
      ? '<div class="icon-btn green" title="Postar agora" onclick="postNow(' + p.id + ',this)">▶</div><div class="icon-btn danger" title="Ignorar" onclick="ignorePromo(' + p.id + ')">✕</div>'
      : '<div class="icon-btn" title="Abrir link" onclick="window.open(\'' + escHtml(p.affiliate_url) + '\',\'_blank\')">↗</div>';
    return '<div class="promo-card" id="promo-' + p.id + '">' +
      '<div class="promo-thumb">' + thumb + '</div>' +
      '<div class="promo-info">' +
        '<div class="promo-title" title="' + escHtml(p.title) + '">' + escHtml(p.title) + '</div>' +
        '<div class="promo-prices"><span class="promo-sale">' + fmtPrice(p.sale_price) + '</span>' +
          (p.original_price ? '<span class="promo-original">' + fmtPrice(p.original_price) + '</span>' : '') + discount + '</div>' +
        '<div class="promo-meta"><span>' + (p.category||'geral') + '</span><span>•</span><span>' + timeAgo(p.found_at) + '</span></div>' +
        '<div class="promo-link">' + (p.affiliate_url||'') + '</div>' +
      '</div>' +
      '<div class="promo-actions"><span class="badge ' + badge + '</span>' + actions + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function postNow(id, btn) {
  btn.innerHTML = '<div class="loader"></div>'; btn.disabled = true;
  fetch('/api/promotions/' + id + '/post', {method:'POST'}).then(function(r){return r.json();}).then(function(r) {
    if (r.success) { toast('Postado!','success'); var el=document.getElementById('promo-'+id); if(el) el.remove(); }
    else { toast(r.reason||r.error||'Erro','error'); btn.innerHTML='▶'; btn.disabled=false; }
  });
}
function ignorePromo(id) {
  fetch('/api/promotions/'+id+'/ignore',{method:'POST'}).then(function(){
    var el=document.getElementById('promo-'+id); if(el) el.remove(); toast('Ignorada','success');
  });
}
function forceScrape(btn) {
  btn.innerHTML='<div class="loader"></div> buscando...'; btn.disabled=true;
  fetch('/api/scrape',{method:'POST'}).then(function(r){return r.json();}).then(function(r){
    toast(r.message||r.error, r.error?'error':'success');
    setTimeout(function(){ btn.innerHTML='<span>↻</span> Buscar agora'; btn.disabled=false; },2000);
  });
}
function openModal() { document.getElementById('channel-modal').classList.add('show'); document.getElementById('ch-id').focus(); }
function closeModal() { document.getElementById('channel-modal').classList.remove('show'); }
function saveChannel() {
  var id=document.getElementById('ch-id').value.trim();
  var name=document.getElementById('ch-name').value.trim();
  var filter=document.getElementById('ch-filter').value.trim();
  if(!id||!name){toast('Preencha ID e nome','error');return;}
  fetch('/api/channels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram_id:id,name:name,category_filter:filter})})
    .then(function(){ closeModal(); toast('Canal adicionado!','success'); renderChannels(); });
}
document.getElementById('channel-modal').addEventListener('click',function(e){ if(e.target===e.currentTarget) closeModal(); });
function fmtPrice(v) { if(!v) return '–'; return 'R$ '+parseFloat(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function timeAgo(d) {
  if(!d) return '';
  var diff=(Date.now()-new Date(d).getTime())/1000;
  if(diff<60) return 'agora';
  if(diff<3600) return Math.floor(diff/60)+'min';
  if(diff<86400) return Math.floor(diff/3600)+'h';
  return Math.floor(diff/86400)+'d';
}
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function toast(msg,type) {
  var t=document.getElementById('toast');
  t.textContent=(type==='success'?'✓ ':'✕ ')+msg;
  t.className='toast show '+(type||'success');
  setTimeout(function(){t.classList.remove('show');},3000);
}
render('dashboard');
updateStatus();
setInterval(updateStatus,10000);
setInterval(function(){ if(currentPage==='dashboard') renderDashboard(); },30000);
</script>
</body>
</html>`;

function startWebServer() {
  const port = process.env.WEB_PORT || 3000;
  app.listen(port, () => console.log(`[Web] Painel disponivel em: http://localhost:${port}`));
  return app;
}

module.exports = { startWebServer, app };