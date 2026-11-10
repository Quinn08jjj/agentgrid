(async function () {
  const $ = (s) => document.querySelector(s);
  const grid = $('#grid');
  const api = window.grid;
  const S = (await api.load()) || { tiles: [], cols: 0 };
  const presets = await api.presets();
  const uid = () => Math.random().toString(36).slice(2, 8);
  const isTerm = (t) => t.kind === 'term';
  const isChat = (t) => t.kind === 'chat';
  const TOOL = { claude: 'claude code', codex: 'codex', opencode: 'opencode' };

  // Older builds ran API providers through Claude Code. Convert those windows into plain chat windows (same stored key).
  S.tiles = S.tiles.map((t) => {
    if (isTerm(t) && t.cmd === 'claude' && t.api) {
      const p = presets.find((x) => x.id === t.api.provider) || {};
      return { id: t.id, kind: 'chat', name: t.api.label || p.label || t.name, zoom: t.zoom || 1, box: t.box, msgs: [],
        api: { provider: t.api.provider, label: t.api.label || p.label, baseUrl: p.baseUrl || t.api.baseUrl, format: p.format, model: p.model || t.api.model, noKey: !!t.api.noKey } };
    }
    return t;
  });
  S.tiles.forEach((t) => { t.zoom = t.zoom || 1; });

  let modal = false, dragging = false, max = null;
  const hidden = new Set();
  const info = {};
  const terms = {};
  const chatRef = {}; // id -> { log, ta }
  const chatBusy = {};
  const save = () => api.save({ tiles: S.tiles.map((t) => (isChat(t) ? { ...t, msgs: (t.msgs || []).slice(-100) } : t)), cols: S.cols, auto: S.auto });

  // ---------- terminals ----------
  function getTerm(t) {
    if (terms[t.id]) return terms[t.id];
    const term = new Terminal({
      fontSize: Math.round(13 * (t.zoom || 1)), cursorBlink: true, allowProposedApi: true, scrollback: 10000,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      theme: { background: '#000000', foreground: '#e6e6e6', cursor: '#ffffff', selectionBackground: '#555555' },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    const rec = { term, fit, exited: false, started: false };
    term.onData((data) => { if (rec.exited) { rec.exited = false; term.reset(); startPty(t, rec); return; } api.pty.input({ id: t.id, data }); });
    term.onResize(({ cols, rows }) => api.pty.resize({ id: t.id, cols, rows }));
    terms[t.id] = rec;
    return rec;
  }
  function startPty(t, rec) {
    api.pty.start({ id: t.id, kind: t.cmd, cwd: t.cwd, configDir: t.configDir, api: t.api, cols: rec.term.cols, rows: rec.term.rows });
    rec.started = true;
  }
  function restartPty(t) { const rec = getTerm(t); api.pty.kill({ id: t.id }); rec.term.reset(); setTimeout(() => startPty(t, rec), 250); }
  function mountTerm(t, body) {
    const rec = getTerm(t);
    if (!rec.term.element) rec.term.open(body); else body.appendChild(rec.term.element);
    body.classList.add('term');
    const doFit = () => { try { rec.fit.fit(); } catch {} };
    requestAnimationFrame(() => { doFit(); if (!rec.started) startPty(t, rec); rec.term.focus(); });
    new ResizeObserver(doFit).observe(body);
  }

  // ---------- chat windows ----------
  function paintMsg(el, m) {
    el.innerHTML = '';
    if (m.reasoning) { const r = document.createElement('div'); r.className = 'rs'; r.textContent = m.reasoning; el.appendChild(r); }
    const parts = (m.content || '').split('```');
    parts.forEach((part, i) => {
      if (i % 2) { const nl = part.indexOf('\n'); const pre = document.createElement('pre'); pre.textContent = nl >= 0 ? part.slice(nl + 1) : part; el.appendChild(pre); }
      else if (part) { const sp = document.createElement('div'); sp.className = 'tx'; sp.textContent = part.replace(/^\n+/, ''); el.appendChild(sp); }
    });
  }
  function addMsgEl(t, m) {
    const ref = chatRef[t.id]; if (!ref) return null;
    const hint = ref.log.querySelector('.hint'); if (hint) hint.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + (m.role === 'user' ? 'u' : m.error ? 'e' : 'a');
    if (m.role === 'user') el.textContent = m.content; else paintMsg(el, m);
    ref.log.appendChild(el); ref.log.scrollTop = ref.log.scrollHeight;
    m._el = el;
    return el;
  }
  function mountChat(t, body) {
    body.classList.add('chat');
    body.style.fontSize = Math.round(12 * (t.zoom || 1)) + 'px';
    body.innerHTML = '<div class="log"></div><div class="send"><span class="pr">›</span><textarea rows="1" spellcheck="false"></textarea></div>';
    const log = body.querySelector('.log'), ta = body.querySelector('textarea');
    chatRef[t.id] = { log, ta };
    ta.placeholder = chatBusy[t.id] ? 'esc to stop' : 'message · enter to send · shift+enter for a new line';
    t.msgs = t.msgs || [];
    if (!t.msgs.length) log.innerHTML = `<div class="hint">${esc(t.api.model || 'no model set')} · ${esc(t.api.baseUrl)}</div>`;
    t.msgs.forEach((m) => addMsgEl(t, m));
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; };
    ta.oninput = grow;
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = ta.value.trim(); if (v) { sendChat(t, v); ta.value = ''; grow(); } }
      else if (e.key === 'Escape' && chatBusy[t.id]) api.chat.stop({ id: t.id });
    };
    requestAnimationFrame(() => ta.focus());
  }
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function sendChat(t, text) {
    if (chatBusy[t.id]) return;
    t.msgs.push({ role: 'user', content: text });
    const user = t.msgs[t.msgs.length - 1];
    const asst = { role: 'assistant', content: '', reasoning: '' };
    t.msgs.push(asst);
    addMsgEl(t, user); addMsgEl(t, asst);
    chatBusy[t.id] = true; setBusy(t.id, true);
    const history = t.msgs.slice(0, -1).filter((m) => !m.error && m.content).slice(-40).map(({ role, content }) => ({ role, content }));
    api.chat.send({ id: t.id, cfg: t.api, messages: history });
  }
  function setBusy(id, b) {
    const ref = chatRef[id]; if (ref) ref.ta.placeholder = b ? 'esc to stop' : 'message · enter to send · shift+enter for a new line';
    const el = grid.querySelector(`.tile[data-id="${id}"] .ld`); if (el) el.classList.toggle('on', b);
  }
  const lastMsg = (id) => S.tiles.find((t) => t.id === id)?.msgs?.slice(-1)[0];
  api.on('chat:delta', ({ id, text, reasoning }) => {
    const t = S.tiles.find((x) => x.id === id); const m = lastMsg(id); if (!m) return;
    if (reasoning) m.reasoning = (m.reasoning || '') + reasoning;
    if (text) m.content += text;
    if (m._el) { paintMsg(m._el, m); const log = chatRef[id]?.log; if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 80) log.scrollTop = log.scrollHeight; }
  });
  api.on('chat:done', ({ id }) => {
    chatBusy[id] = false; setBusy(id, false);
    const m = lastMsg(id); if (m && m.role === 'assistant' && !m.content && !m.reasoning) { const t = S.tiles.find((x) => x.id === id); t.msgs.pop(); m._el?.remove(); }
    save();
  });
  api.on('chat:error', ({ id, message }) => {
    chatBusy[id] = false; setBusy(id, false);
    const t = S.tiles.find((x) => x.id === id); if (!t) return;
    const m = lastMsg(id);
    if (m && m.role === 'assistant' && !m.content) { m.error = true; m.reasoning = ''; m.content = '⚠ ' + message; if (m._el) { m._el.className = 'msg e'; paintMsg(m._el, m); } }
    else { const e = { role: 'assistant', error: true, content: '⚠ ' + message }; t.msgs.push(e); addMsgEl(t, e); }
    save();
  });

  // ---------- layout: every window has its own box (fractions of the area) ----------
  const EPS = 0.0005;
  const overlap = (a, b) => a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
  const visibleTiles = () => S.tiles.filter((t) => !hidden.has(t.id) && (!max || t.id === max));

  function arrange(vis) {
    const n = vis.length || 1;
    const nc = Math.min(S.cols || (n <= 2 ? n : Math.ceil(Math.sqrt(n))), n);
    const nr = Math.ceil(n / nc);
    vis.forEach((t, i) => { const r = Math.floor(i / nc), cnt = Math.min(nc, n - r * nc), c = i - r * nc; t.box = { x: c / cnt, y: r / nr, w: 1 / cnt, h: 1 / nr }; });
    S.auto = true;
  }
  function ensureBoxes(vis) {
    const sig = vis.map((t) => t.id).join(',');
    if (S.auto !== false && (S.sig !== sig || vis.some((t) => !t.box))) { arrange(vis); S.sig = sig; return; }
    for (const t of vis) {
      if (t.box) continue;
      const placed = vis.filter((x) => x.box);
      if (!placed.length) { t.box = { x: 0, y: 0, w: 1, h: 1 }; continue; }
      const big = placed.reduce((m, x) => (x.box.w * x.box.h > m.box.w * m.box.h ? x : m));
      const b = big.box;
      if (b.w * grid.clientWidth >= b.h * grid.clientHeight) { const h = b.w / 2; t.box = { x: b.x + h, y: b.y, w: h, h: b.h }; big.box = { ...b, w: h }; }
      else { const h = b.h / 2; t.box = { x: b.x, y: b.y + h, w: b.w, h }; big.box = { ...b, h }; }
    }
    S.sig = sig;
  }
  function place(el, box) {
    el.style.left = box.x * 100 + '%'; el.style.top = box.y * 100 + '%'; el.style.width = box.w * 100 + '%'; el.style.height = box.h * 100 + '%';
  }

  function render() {
    grid.innerHTML = '';
    $('#cols').value = String(S.cols || 0);
    const vis = visibleTiles();
    $('#empty').hidden = S.tiles.length > 0;
    ensureBoxes(vis);
    for (const t of vis) {
      const el = document.createElement('div');
      el.className = 'tile'; el.dataset.id = t.id;
      place(el, max ? { x: 0, y: 0, w: 1, h: 1 } : t.box);
      el.innerHTML = `<div class="in"><div class="th" title="drag to move · drop on another window to swap · double-click to maximize"><span class="ld"></span><span class="nm" title="double-click to rename"></span><span class="pg"></span>
        <button data-c="menu" title="menu">⋯</button><button data-c="max" title="${max ? 'restore' : 'maximize'}">${max ? '▫' : '□'}</button><button data-c="close" title="remove">×</button></div><div class="body"></div></div>`
        + (max ? '' : ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<i class="rz ${d}" data-d="${d}"></i>`).join(''));
      el.querySelector('.nm').textContent = t.name;
      el.querySelector('.nm').ondblclick = (e) => { e.stopPropagation(); rename(t); };
      el.querySelector('.pg').textContent = isTerm(t) ? (t.api ? t.api.model + ' · ' : '') + TOOL[t.cmd] + ' · ' + t.cwd : isChat(t) ? t.api.model + ' · ' + t.api.provider : '';
      const th = el.querySelector('.th');
      th.addEventListener('click', (e) => onHeaderClick(e, t));
      th.ondblclick = (e) => { if (!e.target.closest('button') && !e.target.closest('.nm')) { max = max ? null : t.id; render(); } };
      if (!max) {
        th.onpointerdown = (e) => { if (!e.target.closest('button')) startMove(e, t, el, th); };
        el.querySelectorAll('.rz').forEach((h) => { h.onpointerdown = (e) => startResize(e, t, el, h.dataset.d, h); });
      }
      grid.appendChild(el);
      const body = el.querySelector('.body');
      if (isTerm(t)) mountTerm(t, body); else if (isChat(t)) { mountChat(t, body); el.querySelector('.ld').classList.toggle('on', !!chatBusy[t.id]); } else paintInfo(t.id);
    }
    chips();
    push();
  }

  // Drag the title bar: the window follows the pointer. Drop it on another window to swap places, or on free space to put it there.
  function startMove(e, t, el, handle) {
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    dragging = true; el.classList.add('active'); push();
    const W = grid.clientWidth, H = grid.clientHeight, gr = grid.getBoundingClientRect();
    const start = { ...t.box }, px = e.clientX, py = e.clientY;
    const others = visibleTiles().filter((x) => x.id !== t.id);
    const elOf = (o) => grid.querySelector(`.tile[data-id="${o.id}"]`);
    let cur = { ...start }, target = null;
    handle.onpointermove = (ev) => {
      const x = Math.min(1 - start.w, Math.max(0, start.x + (ev.clientX - px) / W)), y = Math.min(1 - start.h, Math.max(0, start.y + (ev.clientY - py) / H));
      cur = { ...start, x, y }; place(el, cur);
      const fx = (ev.clientX - gr.left) / W, fy = (ev.clientY - gr.top) / H;
      const hit = others.find((o) => fx >= o.box.x && fx <= o.box.x + o.box.w && fy >= o.box.y && fy <= o.box.y + o.box.h) || null;
      if (hit !== target) { if (target) elOf(target)?.classList.remove('target'); target = hit; if (target) elOf(target)?.classList.add('target'); }
    };
    handle.onpointerup = () => {
      handle.onpointermove = handle.onpointerup = null; dragging = false;
      if (target) { const tb = target.box; target.box = { ...start }; t.box = { ...tb }; }
      else {
        const free = (b) => !others.some((o) => overlap(b, o.box));
        let b = cur;
        if (!free(b)) { let lo = 0, hi = 1; for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2, c = { ...start, x: start.x + (cur.x - start.x) * m, y: start.y + (cur.y - start.y) * m }; if (free(c)) lo = m; else hi = m; } b = { ...start, x: start.x + (cur.x - start.x) * lo, y: start.y + (cur.y - start.y) * lo }; }
        t.box = snapBox(b, others.map((o) => o.box), W, H);
      }
      S.auto = false; save(); render();
    };
  }
  function snapBox(b, boxes, W, H) {
    const xs = [0, 1, ...boxes.flatMap((o) => [o.x, o.x + o.w])], ys = [0, 1, ...boxes.flatMap((o) => [o.y, o.y + o.h])];
    const near = (v, lines, size) => lines.find((l) => Math.abs(v - l) * size < 10);
    let { x, y } = b;
    const nx = near(x, xs, W), nr = near(x + b.w, xs, W), ny = near(y, ys, H), nb = near(y + b.h, ys, H);
    if (nx !== undefined) x = nx; else if (nr !== undefined) x = nr - b.w;
    if (ny !== undefined) y = ny; else if (nb !== undefined) y = nb - b.h;
    const out = { x: Math.max(0, Math.min(1 - b.w, x)), y: Math.max(0, Math.min(1 - b.h, y)), w: b.w, h: b.h };
    return boxes.some((o) => overlap(out, o)) ? b : out;
  }

  function startResize(e, t, el, mode, handle) {
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    dragging = true; el.classList.add('active'); push();
    const W = grid.clientWidth, H = grid.clientHeight;
    const start = { ...t.box }, px = e.clientX, py = e.clientY;
    const others = visibleTiles().filter((x) => x.id !== t.id).map((x) => x.box);
    const xs = [0, 1, ...others.flatMap((o) => [o.x, o.x + o.w])], ys = [0, 1, ...others.flatMap((o) => [o.y, o.y + o.h])];
    const snap = (v, lines, size) => { for (const l of lines) if (Math.abs(v - l) * size < 10) return l; return v; };
    const minW = 170 / W, minH = 100 / H;
    const free = (b) => !others.some((o) => overlap(b, o));
    const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });
    let last = { ...start };
    handle.onpointermove = (ev) => {
      const dx = (ev.clientX - px) / W, dy = (ev.clientY - py) / H;
      let l = start.x, r = start.x + start.w, tp = start.y, bt = start.y + start.h;
      if (mode.includes('w')) l = Math.min(r - minW, Math.max(0, snap(l + dx, xs, W)));
      if (mode.includes('e')) r = Math.max(l + minW, Math.min(1, snap(r + dx, xs, W)));
      if (mode.includes('n')) tp = Math.min(bt - minH, Math.max(0, snap(tp + dy, ys, H)));
      if (mode.includes('s')) bt = Math.max(tp + minH, Math.min(1, snap(bt + dy, ys, H)));
      const cand = { x: l, y: tp, w: r - l, h: bt - tp };
      let use = cand;
      if (!free(cand)) { let lo = 0, hi = 1; for (let i = 0; i < 10; i++) { const m = (lo + hi) / 2; if (free(lerp(last, cand, m))) lo = m; else hi = m; } use = lerp(last, cand, lo); }
      use = { x: Math.max(0, use.x), y: Math.max(0, use.y), w: use.w, h: use.h };
      last = use; t.box = use; place(el, use);
    };
    handle.onpointerup = () => { handle.onpointermove = handle.onpointerup = null; el.classList.remove('active'); dragging = false; S.auto = false; save(); push(); };
  }

  // ---------- header / menu actions ----------
  function onHeaderClick(e, t) {
    const c = e.target.dataset.c; if (!c) return;
    if (c === 'menu') api.tileMenu({ id: t.id, type: isChat(t) ? 'chat' : isTerm(t) ? (t.api ? 'agent' : 'term') : 'web' });
    else if (c === 'max') { max = max ? null : t.id; render(); }
    else if (c === 'close') api.remove({ id: t.id, name: t.name, term: isTerm(t), chat: isChat(t) }).then((ok) => {
      if (!ok) return;
      if (isTerm(t)) { api.pty.kill({ id: t.id }); terms[t.id]?.term.dispose(); delete terms[t.id]; }
      if (isChat(t)) api.chat.stop({ id: t.id });
      S.tiles = S.tiles.filter((x) => x.id !== t.id); hidden.delete(t.id); if (max === t.id) max = null; save(); render();
    });
  }
  api.on('tile:menu', ({ id, action }) => {
    const t = S.tiles.find((x) => x.id === id); if (!t) return;
    if (action === 'rename') rename(t);
    else if (action === 'hide') { hidden.add(id); render(); }
    else if (action === 'zin' || action === 'zout') {
      t.zoom = action === 'zin' ? Math.min(2, +(t.zoom + 0.1).toFixed(2)) : Math.max(0.5, +(t.zoom - 0.1).toFixed(2)); save();
      if (isTerm(t)) { const r = getTerm(t); r.term.options.fontSize = Math.round(13 * t.zoom); try { r.fit.fit(); } catch {} }
      else if (isChat(t)) { const b = grid.querySelector(`.tile[data-id="${id}"] .body`); if (b) b.style.fontSize = Math.round(12 * t.zoom) + 'px'; }
      else push();
    }
    else if (action === 'restart') restartPty(t);
    else if (action === 'cfg') editApi(t);
    else if (action === 'clear') { api.chat.stop({ id }); t.msgs = []; save(); render(); }
    else api.cmd({ id, cmd: action === 'ext' ? 'external' : action, url: t.url });
  });

  function paintInfo(id) {
    const el = grid.querySelector(`.tile[data-id="${id}"]`); if (!el) return;
    const i = info[id] || {};
    el.querySelector('.pg').textContent = i.title || '';
    el.querySelector('.ld').classList.toggle('on', !!i.loading);
  }
  function chips() {
    const box = $('#chips'); box.innerHTML = '';
    S.tiles.filter((t) => hidden.has(t.id)).forEach((t) => {
      const c = document.createElement('span'); c.className = 'chip'; c.textContent = t.name; c.title = 'show';
      c.onclick = () => { hidden.delete(t.id); render(); }; box.appendChild(c);
    });
    $('#restoreAll').hidden = !hidden.size && !max;
  }
  function push() {
    const web = S.tiles.filter((t) => !isTerm(t) && !isChat(t));
    const tiles = web.map((t) => {
      const el = grid.querySelector(`.tile[data-id="${t.id}"] .body`);
      const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      return { id: t.id, url: t.url, zoom: t.zoom, visible: !!el && !modal && !dragging, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    });
    api.sync({ tiles, ids: web.map((t) => t.id) });
  }
  new ResizeObserver(push).observe(grid);
  window.addEventListener('resize', push);

  // ---------- modal ----------
  // fields: [{k,label,value,type,list} | {note}] -> Promise<{k:value}|null>
  function ask(title, fields) {
    return new Promise((res) => {
      modal = true; push();
      $('#mtitle').textContent = title;
      const box = $('#mfields'); box.innerHTML = '';
      fields.forEach((f, n) => {
        if (f.note) { const d = document.createElement('div'); d.className = 'note'; d.textContent = f.note; box.appendChild(d); return; }
        const l = document.createElement('label'); l.textContent = f.label;
        const i = document.createElement('input'); i.type = f.type || 'text'; i.value = f.value || ''; i.placeholder = f.placeholder || ''; i.autocomplete = 'off'; i.dataset.k = f.k;
        if (f.list?.length) { const dl = document.createElement('datalist'); dl.id = 'dl' + n; f.list.forEach((v) => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); }); i.setAttribute('list', dl.id); l.appendChild(dl); }
        l.appendChild(i); box.appendChild(l);
      });
      $('#modal').hidden = false;
      const first = box.querySelector('input'); if (first) { first.focus(); first.select(); }
      const done = (v) => { $('#modal').hidden = true; modal = false; $('#mform').onsubmit = null; $('#mcancel').onclick = null; push(); res(v); };
      $('#mform').onsubmit = (e) => { e.preventDefault(); const o = {}; box.querySelectorAll('input').forEach((i) => (o[i.dataset.k] = i.value.trim())); done(o); };
      $('#mcancel').onclick = () => done(null);
    });
  }

  // ---------- adding / editing ----------
  async function rename(t) {
    const r = await ask('rename window', [{ k: 'name', label: 'name', value: t.name }]); if (!r || !r.name) return;
    t.name = r.name; save(); render();
  }
  function addWeb(name, url) {
    const same = S.tiles.filter((t) => t.url === url).length;
    S.tiles.push({ id: uid(), name: same ? `${name} ${same + 1}` : name, url, zoom: 1 });
    max = null; save(); render();
  }
  function addTerm({ kind, label, cwd, fresh, home }) {
    const id = uid();
    const same = S.tiles.filter((t) => isTerm(t) && t.cmd === kind && !t.api).length;
    const folder = cwd.split('/').filter(Boolean).pop() || cwd;
    S.tiles.push({ id, kind: 'term', cmd: kind, name: `${label} ${same + 1} · ${folder}`, cwd, zoom: 1, configDir: fresh ? `${home}/${kind}-${id}` : '' });
    max = null; save(); render();
  }
  // Two steps: name + key (+url), then pick the model from the list the provider actually offers.
  async function askProvider(p, title) {
    const f1 = [{ k: 'name', label: 'name', value: p.label.replace(/ \(.*\)/, '') }];
    if (p.askUrl || p.id === 'ollama') f1.push({ k: 'baseUrl', label: 'base url', value: p.baseUrl });
    if (p.noKey) f1.push({ note: 'No key needed. Ollama must be running.' });
    else f1.push({ k: 'key', label: 'api key', type: 'password' }, { note: 'Stored encrypted in the macOS keychain.' });
    const r = await ask(title, f1);
    if (!r || (!p.noKey && !r.key)) return null;
    const baseUrl = r.baseUrl || p.baseUrl;
    const m = await api.models({ baseUrl, key: r.key || (p.noKey ? '' : ''), format: p.format });
    const list = m.models || [];
    const def = list.includes(p.model) ? p.model : list[0] || p.model || '';
    const f2 = [{ k: 'model', label: list.length ? `model (${list.length} available — type to filter)` : 'model', value: def, list }];
    if (m.error) f2.push({ note: `Could not list models: ${m.error}` });
    const r2 = await ask(title + ' · model', f2);
    if (!r2 || !r2.model) return null;
    return { name: r.name, key: r.key, baseUrl, model: r2.model };
  }
  async function addChat(p) {
    const r = await askProvider(p, p.label); if (!r) return;
    const id = uid();
    if (r.key) api.setKey({ id, key: r.key });
    S.tiles.push({ id, kind: 'chat', name: r.name, zoom: 1, msgs: [], api: { provider: p.id, label: r.name, baseUrl: r.baseUrl, format: p.format, model: r.model, noKey: !!p.noKey } });
    max = null; save(); render();
  }
  async function addApi(p) {
    const r = await askProvider(p, p.label + ' · coding agent'); if (!r) return;
    const cwd = await api.pickFolder(r.name); if (!cwd) return;
    const id = uid();
    if (r.key) api.setKey({ id, key: r.key });
    S.tiles.push({ id, kind: 'term', cmd: 'opencode', name: r.name + ' · ' + (cwd.split('/').filter(Boolean).pop() || cwd), cwd, zoom: 1, configDir: '',
      api: { provider: p.id, label: r.name, baseUrl: r.baseUrl, model: r.model, noKey: !!p.noKey } });
    max = null; save(); render();
  }
  async function editApi(t) {
    const m = await api.models({ id: t.id, baseUrl: t.api.baseUrl, format: t.api.format });
    const fields = [{ k: 'model', label: 'model', value: t.api.model, list: m.models || [] }, { k: 'baseUrl', label: 'base url', value: t.api.baseUrl }];
    if (!t.api.noKey) fields.push({ k: 'key', label: 'new api key (empty = keep)', type: 'password' });
    const r = await ask('settings · ' + t.name, fields); if (!r) return;
    if (r.model) t.api.model = r.model;
    if (r.baseUrl) t.api.baseUrl = r.baseUrl;
    if (r.key) api.setKey({ id: t.id, key: r.key });
    save();
    if (isTerm(t)) restartPty(t); else render();
  }

  $('#add').onclick = (e) => { const r = e.target.getBoundingClientRect(); api.addMenu({ x: r.left, y: r.bottom }); };
  $('#add2').onclick = () => api.addMenu({ x: innerWidth / 2 - 60, y: innerHeight / 2 });
  const retile = () => { visibleTiles().forEach((t) => delete t.box); S.auto = true; S.sig = ''; save(); render(); };
  $('#cols').onchange = (e) => { S.cols = +e.target.value; retile(); };
  $('#tile').onclick = retile;
  $('#restoreAll').onclick = () => { hidden.clear(); max = null; render(); };
  api.on('tile:add', ({ name, url }) => addWeb(name, url));
  api.on('tile:addTerm', addTerm);
  api.on('tile:addChat', addChat);
  api.on('tile:addApi', addApi);
  api.on('tile:addCustom', async () => {
    const r = await ask('custom website', [{ k: 'name', label: 'name' }, { k: 'url', label: 'url', value: 'https://' }]);
    if (r && r.url) { const u = /^https?:\/\//.test(r.url) ? r.url : 'https://' + r.url; addWeb(r.name || new URL(u).hostname, u); }
  });
  api.on('tile:nav', (d) => { info[d.id] = d; paintInfo(d.id); });
  api.on('pty:data', ({ id, data }) => terms[id]?.term.write(data));
  api.on('pty:exit', ({ id }) => { const r = terms[id]; if (r) { r.exited = true; r.term.write('\r\n\x1b[90m[process exited - press any key to restart]\x1b[0m\r\n'); } });
  render();
})();
