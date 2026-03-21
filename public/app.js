var currentPage = 'dashboard';
var histTab = 'all';

// ─── NAVIGATION ───────────────────────────────────────────────
function navigate(page, el) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(function(e) { e.classList.remove('active'); });
  if (el) el.classList.add('active');
  var titles = {
    dashboard: 'Dashboard', pending: 'Pendentes', history: 'Histórico',
    channels: 'Canais', sources: 'Fontes', manual: 'Nova promoção',
    whatsapp: 'WhatsApp', settings: 'Configuração'
  };
  document.getElementById('page-title').textContent = titles[page] || page;
  render(page);
}

function render(page) {
  document.getElementById('content').innerHTML = '<div class="empty"><div class="loader"></div></div>';
  if      (page === 'dashboard') renderDashboard();
  else if (page === 'pending')   renderPending();
  else if (page === 'history')   renderHistory();
  else if (page === 'channels')  renderChannels();
  else if (page === 'sources')   renderSources();
  else if (page === 'manual')    renderManual();
  else if (page === 'whatsapp')  renderWhatsApp();
  else if (page === 'settings')  renderSettings();
}

// ─── STATUS ───────────────────────────────────────────────────
function updateStatus() {
  fetch('/api/status').then(function(r) { return r.json(); }).then(function(s) {
    var dot = document.getElementById('status-dot');
    var txt = document.getElementById('status-text');
    var rd  = document.getElementById('running-dot');
    if (s.isRunning) {
      dot.className = 'indicator-dot running';
      txt.textContent = 'buscando...';
      if (rd) rd.style.display = '';
    } else {
      dot.className = 'indicator-dot';
      var next = s.nextRunAt ? new Date(s.nextRunAt) : null;
      txt.textContent = next ? 'próxima: ' + next.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : 'aguardando';
      if (rd) rd.style.display = 'none';
    }
  }).catch(function() {});
}

// ─── DASHBOARD ────────────────────────────────────────────────
function renderDashboard() {
  Promise.all([
    fetch('/api/stats').then(function(r) { return r.json(); }),
    fetch('/api/history?limit=10').then(function(r) { return r.json(); })
  ]).then(function(results) {
    var s = results[0];
    var history = results[1];
    var pc = document.getElementById('pending-count');
    if (pc) pc.textContent = s.pending > 0 ? s.pending : '';
    document.getElementById('content').innerHTML =
      '<div class="stats">' +
        '<div class="stat green"><div class="stat-label">Postadas hoje</div><div class="stat-value">' + s.today + '</div></div>' +
        '<div class="stat"><div class="stat-label">Total postadas</div><div class="stat-value">' + s.posted + '</div></div>' +
        '<div class="stat warn"><div class="stat-label">Pendentes</div><div class="stat-value">' + s.pending + '</div></div>' +
        '<div class="stat"><div class="stat-label">Desconto médio</div><div class="stat-value">' + s.avgDiscount + '%</div></div>' +
      '</div>' +
      '<div class="section-header"><div class="section-title">Últimas promoções</div></div>' +
      renderPromoList(history.slice(0, 8), false);
  });
}

// ─── PENDING ──────────────────────────────────────────────────
function renderPending() {
  fetch('/api/pending').then(function(r) { return r.json(); }).then(function(data) {
    document.getElementById('content').innerHTML =
      '<div class="section-header">' +
        '<div class="section-title">Aguardando postagem</div>' +
        '<span class="badge badge-warn">' + data.length + ' pendentes</span>' +
      '</div>' +
      (data.length === 0
        ? '<div class="empty"><div class="empty-icon">✓</div>Nenhuma pendente</div>'
        : renderPromoList(data, true));
  });
}

// ─── HISTORY ──────────────────────────────────────────────────
function renderHistory() {
  fetch('/api/history?limit=50').then(function(r) { return r.json(); }).then(function(data) {
    var filtered = histTab === 'all' ? data
      : histTab === 'posted' ? data.filter(function(p) { return p.status === 'posted'; })
      : data.filter(function(p) { return p.status !== 'posted'; });
    document.getElementById('content').innerHTML =
      '<div class="tabs">' +
        '<div class="tab' + (histTab === 'all'    ? ' active' : '') + '" onclick="setHistTab(\'all\')">Todos</div>' +
        '<div class="tab' + (histTab === 'posted' ? ' active' : '') + '" onclick="setHistTab(\'posted\')">Postados</div>' +
        '<div class="tab' + (histTab === 'other'  ? ' active' : '') + '" onclick="setHistTab(\'other\')">Outros</div>' +
      '</div>' +
      (filtered.length === 0
        ? '<div class="empty"><div class="empty-icon">📋</div>Nenhuma</div>'
        : renderPromoList(filtered, false));
  });
}

function setHistTab(tab) { histTab = tab; renderHistory(); }

// ─── CHANNELS ─────────────────────────────────────────────────
function renderChannels() {
  fetch('/api/channels').then(function(r) { return r.json(); }).then(function(data) {
    var cards = data.map(function(c) {
      return '<div class="channel-card" id="ch-' + c.id + '">' +
        '<div class="channel-name"><span>' + (c.active ? '🟢' : '⚫') + '</span> ' + escHtml(c.name) + '</div>' +
        '<div class="channel-id">' + c.telegram_id + '</div>' +
        (c.category_filter ? '<div style="font-size:11px;color:var(--info);margin-top:4px">filtro: ' + escHtml(c.category_filter) + '</div>' : '') +
        '<div class="channel-footer">' +
          '<span class="badge ' + (c.active ? 'badge-green' : 'badge-gray') + '">' + (c.active ? 'ativo' : 'pausado') + '</span>' +
          '<div class="toggle ' + (c.active ? 'on' : '') + '" onclick="toggleCh(' + c.id + ')"></div>' +
        '</div>' +
      '</div>';
    }).join('');
    document.getElementById('content').innerHTML =
      '<div class="section-header"><div class="section-title">Canais</div></div>' +
      '<div class="channels-grid">' +
        cards +
        '<div class="channel-card add-channel-card" onclick="openModal()"><div style="font-size:24px">+</div><div>Adicionar canal</div></div>' +
      '</div>';
  });
}

function toggleCh(id) {
  fetch('/api/channels/' + id + '/toggle', { method: 'PATCH' }).then(function() {
    renderChannels();
    toast('Canal atualizado', 'success');
  });
}

// ─── SOURCES ──────────────────────────────────────────────────
function renderSources() {
  fetch('/api/sources').then(function(r) { return r.json(); }).then(function(data) {
    var info = {
      shopee:    { icon: '🧡', label: 'Shopee',              desc: 'API afiliados Shopee',          cred: 'SHOPEE_APP_ID + SHOPEE_SECRET', link: 'https://affiliate.shopee.com.br' },
      shopee_kw: { icon: '🔎', label: 'Shopee keywords',     desc: 'Busca por keyword Shopee',       cred: 'SHOPEE_APP_ID + SHOPEE_SECRET', link: 'https://affiliate.shopee.com.br' },
      rakuten:   { icon: '🏪', label: 'Rakuten Coupon Feed', desc: 'Netshoes, Americanas e +50 lojas', cred: 'RAKUTEN_WS_TOKEN',             link: 'https://publisher.rakutenadvertising.com' },
    };
    var cards = data.map(function(s) {
      var i = info[s.id] || { icon: '◉', label: s.name, desc: '', cred: '', link: null };
      var lr = s.last_run ? timeAgo(s.last_run) : 'nunca';
      return '<div class="source-card ' + (s.active ? 'active' : '') + '">' +
        '<div class="source-head">' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<span style="font-size:22px">' + i.icon + '</span>' +
            '<div><div class="source-name">' + i.label + '</div><div class="source-desc">' + i.desc + '</div></div>' +
          '</div>' +
          '<div class="toggle ' + (s.active ? 'on' : '') + '" onclick="toggleSrc(\'' + s.id + '\',this)"></div>' +
        '</div>' +
        '<div class="source-footer">' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<span class="badge ' + (s.active ? 'badge-green' : 'badge-gray') + '">' + (s.active ? 'ativo' : 'inativo') + '</span>' +
            (s.last_count > 0 ? '<span class="badge badge-info">' + s.last_count + ' promos</span>' : '') +
            '<span style="font-size:11px;color:var(--muted)">' + lr + '</span>' +
          '</div>' +
          (i.link ? '<a href="' + i.link + '" target="_blank" style="font-size:11px;color:var(--info)">Cadastrar →</a>' : '') +
        '</div>' +
      '</div>';
    }).join('');
    document.getElementById('content').innerHTML =
      '<div class="section-header">' +
        '<div class="section-title">Fontes</div>' +
        '<button class="btn" style="font-size:12px;padding:4px 10px" onclick="forceScrape(this)">↻ Buscar agora</button>' +
      '</div>' +
      '<div class="sources-grid">' + cards + '</div>';
  });
}

function toggleSrc(id, el) {
  fetch('/api/sources/' + id + '/toggle', { method: 'PATCH' }).then(function() {
    el.classList.toggle('on');
    var card = el.closest('.source-card');
    card.classList.toggle('active');
    var badge = card.querySelector('.badge');
    var on = el.classList.contains('on');
    badge.className = 'badge ' + (on ? 'badge-green' : 'badge-gray');
    badge.textContent = on ? 'ativo' : 'inativo';
    toast(on ? 'Fonte ativada' : 'Fonte desativada', 'success');
  });
}

// ─── MANUAL ───────────────────────────────────────────────────
function renderManual() {
  document.getElementById('content').innerHTML =
    '<div style="max-width:520px">' +
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:16px">Cadastrar promoção manualmente</div>' +
        '<div class="field"><label>Título *</label><input type="text" id="m-title" placeholder="Ex: Nike Air Max 270" /></div>' +
        '<div class="field"><label>Link de afiliado *</label><input type="text" id="m-url" placeholder="https://..." /></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<div class="field"><label>Preço com desconto (R$)</label><input type="number" id="m-sale" placeholder="199.90" step="0.01" /></div>' +
          '<div class="field"><label>Preço original (R$)</label><input type="number" id="m-original" placeholder="299.90" step="0.01" /></div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
          '<div class="field"><label>Loja</label><input type="text" id="m-seller" placeholder="Ex: Netshoes" /></div>' +
          '<div class="field"><label>Código do cupom</label><input type="text" id="m-coupon" placeholder="Ex: PROMO10" /></div>' +
        '</div>' +
        '<div class="field"><label>URL da imagem (opcional)</label><input type="text" id="m-image" placeholder="https://..." /></div>' +
        '<div id="m-preview" style="display:none;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin:12px 0;font-size:12px;font-family:var(--mono);white-space:pre-wrap;line-height:1.6"></div>' +
        '<div style="display:flex;gap:8px;margin-top:4px">' +
          '<button class="btn" onclick="previewManual()">👁 Prévia</button>' +
          '<button class="btn btn-green" onclick="submitManual(this)">✚ Adicionar à fila</button>' +
        '</div>' +
      '</div>' +
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;font-size:12px;color:var(--muted)">' +
        '<div style="font-weight:600;color:var(--text);margin-bottom:6px">Como funciona</div>' +
        '<div>A promoção entra na fila e é postada automaticamente. Para postar imediatamente, vá em <strong style="color:var(--text)">Pendentes</strong> e clique em ▶.</div>' +
      '</div>' +
    '</div>';
}

function previewManual() {
  var title    = document.getElementById('m-title').value.trim();
  var url      = document.getElementById('m-url').value.trim() || 'https://...';
  var sale     = parseFloat(document.getElementById('m-sale').value) || 0;
  var original = parseFloat(document.getElementById('m-original').value) || 0;
  var seller   = document.getElementById('m-seller').value.trim() || 'loja parceira';
  var coupon   = document.getElementById('m-coupon').value.trim();
  if (!title) { toast('Preencha o título', 'error'); return; }
  var discount = (original > sale && sale > 0) ? Math.round(((original - sale) / original) * 100) : 0;
  var fire = discount >= 50 ? '🚨🔥' : discount >= 30 ? '💥' : '🔥';
  var lines = [fire + ' ' + title, ''];
  if (original && sale) {
    lines.push('💰 De: R$ ' + original.toFixed(2).replace('.', ','));
    lines.push('🏷 Por: R$ ' + sale.toFixed(2).replace('.', ',') + (discount ? '  ✅ -' + discount + '% OFF' : ''));
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
  if (!title) { toast('Título é obrigatório', 'error'); return; }
  if (!url)   { toast('Link é obrigatório', 'error'); return; }
  btn.innerHTML = '<div class="loader"></div> salvando...';
  btn.disabled = true;
  fetch('/api/promotions/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: title, affiliate_url: url, sale_price: sale, original_price: original,
      seller: seller, extra_info: coupon ? 'Cupom: ' + coupon : null, image_url: image || null
    })
  }).then(function(r) { return r.json(); }).then(function(r) {
    if (r.ok) {
      toast('Promoção adicionada à fila!', 'success');
      ['m-title','m-url','m-sale','m-original','m-seller','m-coupon','m-image'].forEach(function(id) {
        document.getElementById(id).value = '';
      });
      document.getElementById('m-preview').style.display = 'none';
    } else {
      toast(r.error || 'Erro ao salvar', 'error');
    }
    btn.innerHTML = '✚ Adicionar à fila';
    btn.disabled = false;
  });
}

// ─── WHATSAPP ─────────────────────────────────────────────────
function renderWhatsApp() {
  document.getElementById('content').innerHTML =
    '<div style="max-width:480px">' +
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:6px">Status da conexão</div>' +
        '<div id="wa-status" style="font-size:12px;color:var(--muted)">Verificando...</div>' +
        '<div style="margin-top:12px;display:flex;gap:8px">' +
          '<button class="btn btn-green" onclick="loadQR(this)">📱 Gerar QR Code</button>' +
          '<button class="btn" onclick="checkWaStatus()">↻ Verificar status</button>' +
        '</div>' +
      '</div>' +
      '<div id="qr-box" style="display:none;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;text-align:center;margin-bottom:14px">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:12px">Escaneie com seu WhatsApp</div>' +
        '<div id="qr-content" style="min-height:200px;display:flex;align-items:center;justify-content:center"><div class="loader"></div></div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:10px">WhatsApp → Dispositivos conectados → Conectar dispositivo</div>' +
        '<div style="margin-top:10px;display:flex;gap:8px;justify-content:center">' +
          '<button class="btn" onclick="loadQR(this)">↻ Atualizar QR</button>' +
          '<button class="btn" onclick="document.getElementById(\'qr-box\').style.display=\'none\'">Fechar</button>' +
        '</div>' +
      '</div>' +
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:8px">Canais configurados</div>' +
        '<div id="wa-channels" style="font-size:12px;color:var(--muted);line-height:2;font-family:var(--mono)">Carregando...</div>' +
      '</div>' +
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:8px">Como conectar</div>' +
        '<ol style="font-size:12px;color:var(--muted);padding-left:16px;line-height:2.2">' +
          '<li>Clique em <strong style="color:var(--text)">Gerar QR Code</strong></li>' +
          '<li>Abra o WhatsApp no celular</li>' +
          '<li>Toque em <strong style="color:var(--text)">Dispositivos conectados</strong></li>' +
          '<li>Toque em <strong style="color:var(--text)">Conectar dispositivo</strong></li>' +
          '<li>Escaneie o QR code</li>' +
        '</ol>' +
        '<div style="margin-top:10px;font-size:11px;color:var(--muted)">' +
          'Variáveis no Railway: ' +
          '<code style="color:var(--accent)">WAPI_INSTANCE_ID</code>, ' +
          '<code style="color:var(--accent)">WAPI_TOKEN</code>, ' +
          '<code style="color:var(--accent)">WAPI_CHANNELS</code>' +
        '</div>' +
      '</div>' +
    '</div>';
  checkWaStatus();
}

function loadQR(btn) {
  btn.innerHTML = '<div class="loader"></div>';
  btn.disabled = true;
  document.getElementById('qr-box').style.display = '';
  document.getElementById('qr-content').innerHTML = '<div class="loader"></div>';
  fetch('/api/whatsapp/qrcode').then(function(r) { return r.json(); }).then(function(r) {
    var el = document.getElementById('qr-content');
    if (r.error) {
      el.innerHTML = '<div style="color:var(--danger);font-size:13px">' + r.error + '</div>';
    } else if (r.base64) {
      el.innerHTML = '<img src="' + r.base64 + '" style="max-width:240px;border-radius:8px">';
    } else if (r.qrcode || r.qr || r.image || r.value) {
      var img = r.qrcode || r.qr || r.image || r.value;
      var src = img.indexOf('data:') === 0 ? img : 'data:image/png;base64,' + img;
      el.innerHTML = '<img src="' + src + '" style="max-width:240px;border-radius:8px">';
    } else {
      el.innerHTML = '<pre style="font-size:10px;color:var(--text);text-align:left">' + JSON.stringify(r, null, 2).substring(0, 500) + '</pre>';
    }
    btn.innerHTML = '📱 Gerar QR Code';
    btn.disabled = false;
  }).catch(function(err) {
    document.getElementById('qr-content').innerHTML = '<div style="color:var(--danger)">Erro: ' + err.message + '</div>';
    btn.innerHTML = '📱 Gerar QR Code';
    btn.disabled = false;
  });
}

function checkWaStatus() {
  var el = document.getElementById('wa-status');
  if (!el) return;
  el.textContent = 'Verificando...';
  fetch('/api/whatsapp/channels').then(function(r) { return r.json(); }).then(function(ch) {
    var chEl = document.getElementById('wa-channels');
    if (chEl) {
      chEl.innerHTML = ch.channels.length
        ? ch.channels.map(function(c) { return '<div>' + c + '</div>'; }).join('')
        : '<div style="color:var(--warn)">Nenhum canal configurado — adicione WAPI_CHANNELS no Railway</div>';
    }
  }).catch(function() {});
  fetch('/api/whatsapp/status').then(function(r) { return r.json(); }).then(function(r) {
    if (r.connected) {
      var id = (r.data && r.data.instanceId) ? ' — ' + r.data.instanceId : '';
      el.innerHTML = '<span style="color:var(--accent)">✓ Conectado' + id + '</span>';
    } else {
      el.innerHTML = '<span style="color:var(--warn)">✗ Desconectado' + (r.error ? ' — ' + r.error : '') + '</span>';
    }
  }).catch(function() { el.innerHTML = '<span style="color:var(--danger)">Erro ao verificar</span>'; });
}

// ─── SETTINGS ─────────────────────────────────────────────────
function renderSettings() {
  document.getElementById('content').innerHTML =
    '<div style="max-width:520px">' +
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:14px">Testar conexão</div>' +
        '<button class="btn btn-green" onclick="testTelegram(this)">Testar bot Telegram</button>' +
        '<button class="btn" onclick="testWhatsapp(this)" style="margin-left:8px">Testar WhatsApp</button>' +
        '<div id="test-result" style="margin-top:10px;font-size:12px;font-family:var(--mono);color:var(--muted)"></div>' +
      '</div>' +
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:8px">Banco de dados</div>' +
        '<div style="font-size:12px;color:var(--muted)">Localização: <code style="color:var(--text)">data/promobot.db</code></div>' +
      '</div>' +
    '</div>';
}

function testWhatsapp(btn) {
  btn.innerHTML = '<div class="loader"></div> testando...';
  btn.disabled = true;
  fetch('/api/whatsapp/test').then(function(r) { return r.json(); }).then(function(r) {
    var el = document.getElementById('test-result');
    el.textContent = r.ok ? '✓ WhatsApp conectado' : '✗ Erro: ' + r.error;
    el.style.color = r.ok ? 'var(--accent)' : 'var(--danger)';
    btn.innerHTML = 'Testar WhatsApp';
    btn.disabled = false;
  });
}

function testTelegram(btn) {
  btn.innerHTML = '<div class="loader"></div> testando...';
  btn.disabled = true;
  fetch('/api/telegram/test').then(function(r) { return r.json(); }).then(function(r) {
    var el = document.getElementById('test-result');
    el.textContent = r.ok ? '✓ Conectado: @' + (r.bot && r.bot.username) : '✗ Erro: ' + r.error;
    el.style.color = r.ok ? 'var(--accent)' : 'var(--danger)';
    btn.innerHTML = 'Testar bot Telegram';
    btn.disabled = false;
  });
}

// ─── PROMO CARDS ──────────────────────────────────────────────
function renderPromoList(promos, showActions) {
  if (!promos.length) return '<div class="empty"><div class="empty-icon">📭</div>Nenhuma promoção encontrada</div>';
  return '<div class="promo-list">' + promos.map(function(p) {
    var badgeClass = p.status === 'posted' ? 'badge-green' : p.status === 'pending' ? 'badge-warn' : 'badge-gray';
    var badgeText  = p.status === 'posted' ? '✓ postado'  : p.status === 'pending' ? 'pendente'   : 'ignorado';
    var thumb = p.image_url
      ? '<img src="' + escHtml(p.image_url) + '" onerror="this.parentElement.textContent=\'🏷\'" />'
      : '🏷';
    var discount = p.discount_percent ? '<span class="badge badge-danger">-' + p.discount_percent + '%</span>' : '';
    var actions = showActions
      ? '<div class="icon-btn green" title="Postar agora" onclick="postNow(' + p.id + ',this)">▶</div>' +
        '<div class="icon-btn danger" title="Ignorar" onclick="ignorePromo(' + p.id + ')">✕</div>'
      : '<div class="icon-btn" title="Abrir link" onclick="window.open(\'' + escHtml(p.affiliate_url) + '\',\'_blank\')">↗</div>';
    return '<div class="promo-card" id="promo-' + p.id + '">' +
      '<div class="promo-thumb">' + thumb + '</div>' +
      '<div class="promo-info">' +
        '<div class="promo-title" title="' + escHtml(p.title) + '">' + escHtml(p.title) + '</div>' +
        '<div class="promo-prices">' +
          '<span class="promo-sale">' + fmtPrice(p.sale_price) + '</span>' +
          (p.original_price ? '<span class="promo-original">' + fmtPrice(p.original_price) + '</span>' : '') +
          discount +
        '</div>' +
        '<div class="promo-meta"><span>' + (p.category || 'geral') + '</span><span>•</span><span>' + timeAgo(p.found_at) + '</span></div>' +
        '<div class="promo-link">' + (p.affiliate_url || '') + '</div>' +
      '</div>' +
      '<div class="promo-actions"><span class="badge ' + badgeClass + '">' + badgeText + '</span>' + actions + '</div>' +
    '</div>';
  }).join('') + '</div>';
}

// ─── ACTIONS ──────────────────────────────────────────────────
function postNow(id, btn) {
  btn.innerHTML = '<div class="loader"></div>';
  btn.disabled = true;
  fetch('/api/promotions/' + id + '/post', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(r) {
    if (r.success) {
      toast('Postado!', 'success');
      var el = document.getElementById('promo-' + id);
      if (el) el.remove();
    } else {
      toast(r.reason || r.error || 'Erro', 'error');
      btn.innerHTML = '▶';
      btn.disabled = false;
    }
  });
}

function ignorePromo(id) {
  fetch('/api/promotions/' + id + '/ignore', { method: 'POST' }).then(function() {
    var el = document.getElementById('promo-' + id);
    if (el) el.remove();
    toast('Ignorada', 'success');
  });
}

function forceScrape(btn) {
  btn.innerHTML = '<div class="loader"></div> buscando...';
  btn.disabled = true;
  fetch('/api/scrape', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(r) {
    toast(r.message || r.error, r.error ? 'error' : 'success');
    setTimeout(function() { btn.innerHTML = '<span>↻</span> Buscar agora'; btn.disabled = false; }, 2000);
  });
}

// ─── MODAL ────────────────────────────────────────────────────
function openModal() {
  document.getElementById('channel-modal').classList.add('show');
  document.getElementById('ch-id').focus();
}

function closeModal() {
  document.getElementById('channel-modal').classList.remove('show');
}

function addChannel() {
  var id     = document.getElementById('ch-id').value.trim();
  var name   = document.getElementById('ch-name').value.trim();
  var filter = document.getElementById('ch-filter').value.trim();
  if (!id || !name) { toast('Preencha ID e nome', 'error'); return; }
  fetch('/api/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegram_id: id, name: name, category_filter: filter })
  }).then(function() {
    closeModal();
    toast('Canal adicionado!', 'success');
    renderChannels();
  });
}

document.getElementById('channel-modal').addEventListener('click', function(e) {
  if (e.target === e.currentTarget) closeModal();
});

// ─── UTILS ────────────────────────────────────────────────────
function fmtPrice(v) {
  if (!v) return '–';
  return 'R$ ' + parseFloat(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(d) {
  if (!d) return '';
  var diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60)    return 'agora';
  if (diff < 3600)  return Math.floor(diff / 60) + 'min';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = (type === 'success' ? '✓ ' : '✕ ') + msg;
  t.className = 'toast show ' + (type || 'success');
  setTimeout(function() { t.classList.remove('show'); }, 3000);
}

// ─── INIT ─────────────────────────────────────────────────────
render('dashboard');
updateStatus();
setInterval(updateStatus, 10000);
setInterval(function() { if (currentPage === 'dashboard') renderDashboard(); }, 30000);