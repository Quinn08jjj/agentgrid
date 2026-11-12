(async function () {
  const $ = (s) => document.querySelector(s);
  const grid = $('#grid');
  const api = window.grid;
  const S = (await api.load()) || { tiles: [], cols: 0 };
  const presets = await api.presets();
  const uid = () => Math.random().toString(36).slice(2, 8);
  const isTerm = (t) => t.kind === 'term';
  const isChat = (t) => t.kind === 'chat';
  const TOOL = { claude: 'claude code', codex: 'codex', opencode: 'opencode', shell: 'terminal' };

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

  let modal = false, dragging = false, max = null, splash = true;
  setTimeout(() => { $('#splash').classList.add('out'); splash = false; push(); setTimeout(() => $('#splash').remove(), 600); }, 2300);
  const hidden = new Set();
  const info = {};
  const terms = {};
  const chatRef = {}; // id -> { log, ta }
  const chatBusy = {};
  const lastData = {};   // id -> timestamp of last terminal output (activity indicator)
  const sel = new Set(); // windows selected in the agents dock
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
    const fitNow = () => { try { rec.fit.fit(); } catch {} };
    let ft = 0; const doFit = () => { clearTimeout(ft); ft = setTimeout(fitNow, 70); };
    requestAnimationFrame(() => { fitNow(); if (!rec.started) startPty(t, rec); rec.term.focus(); });
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
    chatBusy[id] = false; setBusy(id, false); renderDock();
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

  // cheap re-layout: just move the existing elements (no remount, no black flash)
  function relayout() {
    grid.classList.add('settle'); clearTimeout(relayout.t); relayout.t = setTimeout(() => grid.classList.remove('settle'), 220);
    for (const t of visibleTiles()) { const el = grid.querySelector(`.tile[data-id="${t.id}"]`); if (el) place(el, max ? { x: 0, y: 0, w: 1, h: 1 } : t.box); }
    renderDock(); push();
  }
  // web views are native and cannot follow the DOM while dragging: show a snapshot instead of a black hole
  async function freezeWeb() {
    await Promise.all(S.tiles.filter((t) => !isTerm(t) && !isChat(t)).map(async (t) => {
      const body = grid.querySelector(`.tile[data-id="${t.id}"] .body`); if (!body) return;
      const url = await api.snap(t.id); if (url && dragging) { body.style.backgroundImage = `url(${url})`; body.classList.add('frozen'); }
    }));
    if (dragging) push();
  }
  function thawWeb() { setTimeout(() => grid.querySelectorAll('.body.frozen').forEach((b) => { b.classList.remove('frozen'); b.style.backgroundImage = ''; }), 80); }

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
    renderDock();
    push();
  }

  // Drag the title bar: the window sticks to the pointer; the window under the pointer slides into the free slot (live swap).
  // Pointer at the border of the work area = snap to that half.
  function startMove(e, t, el, handle) {
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    dragging = true; el.classList.add('active'); grid.classList.add('moving'); freezeWeb();
    const W = grid.clientWidth, H = grid.clientHeight, gr = grid.getBoundingClientRect();
    const start = { ...t.box }, px = e.clientX, py = e.clientY;
    let slot = { ...start }, zone = null, moved = false, pend = null, swapT = 0;
    const others = visibleTiles().filter((x) => x.id !== t.id);
    const elOf = (o) => grid.querySelector(`.tile[data-id="${o.id}"]`);
    const hint = document.createElement('div'); hint.id = 'snaphint'; grid.appendChild(hint);
    handle.onpointermove = (ev) => {
      if (!moved && Math.abs(ev.clientX - px) + Math.abs(ev.clientY - py) < 4) return;
      moved = true;
      const x = Math.min(1 - start.w, Math.max(0, start.x + (ev.clientX - px) / W)), y = Math.min(1 - start.h, Math.max(0, start.y + (ev.clientY - py) / H));
      place(el, { x, y, w: start.w, h: start.h });
      const edge = 26;
      zone = ev.clientX - gr.left < edge ? 'left' : gr.right - ev.clientX < edge ? 'right' : ev.clientY - gr.top < edge ? 'top' : gr.bottom - ev.clientY < edge ? 'bottom' : null;
      if (zone) { const r = ZONES[zone]; hint.style.cssText = `display:block;left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`; hint.style.display = 'block'; return; }
      hint.style.display = 'none';
      const fx = (ev.clientX - gr.left) / W, fy = (ev.clientY - gr.top) / H;
      const hit = others.find((o) => fx >= o.box.x && fx <= o.box.x + o.box.w && fy >= o.box.y && fy <= o.box.y + o.box.h);
      if (hit === pend) return;
      clearTimeout(swapT); pend = hit;
      // swap only when the pointer rests on a window briefly - passing over it does not shuffle everything
      if (hit) swapT = setTimeout(() => { const tmp = { ...hit.box }; hit.box = { ...slot }; slot = tmp; const he = elOf(hit); if (he) place(he, hit.box); pend = null; }, 110);
    };
    handle.onpointerup = () => {
      handle.onpointermove = handle.onpointerup = null; clearTimeout(swapT); dragging = false; hint.remove(); grid.classList.remove('moving');
      if (moved && zone) { el.classList.remove('active'); snapWindow(t, zone); thawWeb(); return; }
      t.box = slot; el.classList.add('settle'); place(el, slot);
      if (moved) { S.auto = false; save(); }
      push(); renderDock(); thawWeb();
      setTimeout(() => { el.classList.remove('settle', 'active'); }, 200);
    };
  }

  // Resize one edge/corner. Neighbours that share the edge move with it (they shrink / grow),
  // until they reach the minimum size - nothing "is in the way".
  function startResize(e, t, el, mode, handle) {
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    dragging = true; el.classList.add('active'); freezeWeb();
    const W = grid.clientWidth, H = grid.clientHeight;
    const start = { ...t.box }, px = e.clientX, py = e.clientY;
    const others = visibleTiles().filter((x) => x.id !== t.id).map((x) => ({ t: x, ob: { ...x.box } }));
    const xs = [0, 1, ...others.flatMap((o) => [o.ob.x, o.ob.x + o.ob.w])], ys = [0, 1, ...others.flatMap((o) => [o.ob.y, o.ob.y + o.ob.h])];
    const snap = (v, lines, size) => { for (const l of lines) if (Math.abs(v - l) * size < 8) return l; return v; };
    const MIN = { w: 170 / W, h: 100 / H };
    const elOf = (x) => grid.querySelector(`.tile[data-id="${x.id}"]`);
    // move one side of `box` to `v`; mutates cur[] (the neighbours' boxes) and returns the clamped value
    function side(box, sd, v, cur) {
      const horiz = sd === 'e' || sd === 'w', pos = sd === 'e' || sd === 's';
      const [P, L, Q, M] = horiz ? ['x', 'w', 'y', 'h'] : ['y', 'h', 'x', 'w'];
      const min = horiz ? MIN.w : MIN.h;
      const sEdge = pos ? start[P] + start[L] : start[P];
      const qa = Math.min(box[Q], start[Q]), qb = Math.max(box[Q] + box[M], start[Q] + start[M]);
      const cands = others.filter((o) => {
        const ob = o.ob; if (!(ob[Q] < qb - EPS && ob[Q] + ob[M] > qa + EPS)) return false;
        return pos ? ob[P] >= sEdge - EPS : ob[P] + ob[L] <= sEdge + EPS;
      });
      const touching = (ob) => Math.abs((pos ? ob[P] : ob[P] + ob[L]) - sEdge) < EPS;
      v = snap(v, horiz ? xs : ys, horiz ? W : H);
      // own minimum / work-area bounds
      v = pos ? Math.min(1, Math.max(start[P] + min, v)) : Math.max(0, Math.min(start[P] + start[L] - min, v));
      // neighbours' minimum
      for (const o of cands) {
        const ob = o.ob, hit = touching(ob) || (pos ? ob[P] < v - EPS : ob[P] + ob[L] > v + EPS);
        if (!hit) continue;
        v = pos ? Math.min(v, ob[P] + ob[L] - min) : Math.max(v, ob[P] + min);
      }
      for (const o of cands) {
        const ob = o.ob, c = cur.get(o);
        const hit = touching(ob) || (pos ? ob[P] < v - EPS : ob[P] + ob[L] > v + EPS);
        if (!hit) continue;
        if (pos) { c[P] = v; c[L] = ob[P] + ob[L] - v; } else { c[L] = v - ob[P]; }
      }
      if (pos) box[L] = v - box[P]; else { box[L] = start[P] + start[L] - v; box[P] = v; }
      return v;
    }
    let frame = 0, ev0 = null;
    const apply = () => {
      frame = 0; const ev = ev0; if (!ev) return;
      const dx = (ev.clientX - px) / W, dy = (ev.clientY - py) / H;
      const box = { ...start }, cur = new Map(others.map((o) => [o, { ...o.ob }]));
      if (mode.includes('e')) side(box, 'e', start.x + start.w + dx, cur);
      if (mode.includes('w')) side(box, 'w', start.x + dx, cur);
      if (mode.includes('s')) side(box, 's', start.y + start.h + dy, cur);
      if (mode.includes('n')) side(box, 'n', start.y + dy, cur);
      t.box = box; place(el, box);
      for (const o of others) { o.t.box = cur.get(o); const oe = elOf(o.t); if (oe) place(oe, o.t.box); }
    };
    handle.onpointermove = (ev) => { ev0 = ev; if (!frame) frame = requestAnimationFrame(apply); };
    handle.onpointerup = () => { handle.onpointermove = handle.onpointerup = null; if (frame) { cancelAnimationFrame(frame); apply(); } el.classList.remove('active'); dragging = false; S.auto = false; save(); push(); renderDock(); thawWeb(); };
  }

  // ---------- layout presets and half-screen snapping ----------
  const ZONES = { left: { x: 0, y: 0, w: 0.5, h: 1 }, right: { x: 0.5, y: 0, w: 0.5, h: 1 }, top: { x: 0, y: 0, w: 1, h: 0.5 }, bottom: { x: 0, y: 0.5, w: 1, h: 0.5 } };
  const COMPLEMENT = { left: ZONES.right, right: ZONES.left, top: ZONES.bottom, bottom: ZONES.top };
  // lay `list` out inside `rect`; nc = number of columns (default ~square)
  function tileIn(rect, list, nc) {
    const n = list.length; if (!n) return;
    nc = Math.min(nc || (n <= 2 ? n : Math.ceil(Math.sqrt(n))), n);
    const nr = Math.ceil(n / nc);
    list.forEach((t, i) => {
      const r = Math.floor(i / nc), cnt = Math.min(nc, n - r * nc), c = i - r * nc;
      t.box = { x: rect.x + (c / cnt) * rect.w, y: rect.y + (r / nr) * rect.h, w: rect.w / cnt, h: rect.h / nr };
    });
  }
  function snapWindow(t, zone) {
    const others = visibleTiles().filter((x) => x.id !== t.id);
    t.box = { ...ZONES[zone] };
    if (!others.length) t.box = { x: 0, y: 0, w: 1, h: 1 };
    else { const vert = zone === 'left' || zone === 'right'; tileIn(COMPLEMENT[zone], others, vert ? (others.length > 4 ? 2 : 1) : (others.length > 4 ? Math.ceil(others.length / 2) : others.length)); }
    S.auto = false; save(); relayout();
  }
  function applyLayout(kind) {
    const vis = visibleTiles(); if (!vis.length) return;
    const [main, ...rest] = vis, full = { x: 0, y: 0, w: 1, h: 1 };
    const stack = (rect) => tileIn(rect, rest, rest.length > 4 ? 2 : 1);
    if (kind === 'grid') { retile(); return; }
    else if (kind === 'cols') tileIn(full, vis, vis.length);
    else if (kind === 'rows') tileIn(full, vis, 1);
    else if (!rest.length) main.box = { ...full };
    else if (kind === 'main-left-50') { main.box = { x: 0, y: 0, w: 0.5, h: 1 }; stack({ x: 0.5, y: 0, w: 0.5, h: 1 }); }
    else if (kind === 'main-left-66') { main.box = { x: 0, y: 0, w: 2 / 3, h: 1 }; stack({ x: 2 / 3, y: 0, w: 1 / 3, h: 1 }); }
    else if (kind === 'main-right-50') { main.box = { x: 0.5, y: 0, w: 0.5, h: 1 }; stack({ x: 0, y: 0, w: 0.5, h: 1 }); }
    else if (kind === 'main-top-50') { main.box = { x: 0, y: 0, w: 1, h: 0.5 }; tileIn({ x: 0, y: 0.5, w: 1, h: 0.5 }, rest, rest.length); }
    S.auto = false; const wasMax = !!max; max = null; save(); wasMax ? render() : relayout();
  }
  api.on('layout:apply', ({ kind }) => applyLayout(kind));

  // ---------- agents dock: overview of every window + broadcast / orchestration ----------
  const TYPE = (t) => (isChat(t) ? 'chat' : isTerm(t) ? TOOL[t.cmd] : 'website');
  function statusOf(t) {
    if (isChat(t)) return chatBusy[t.id] ? ['w', 'working'] : ['', 'idle'];
    if (isTerm(t)) {
      const rec = terms[t.id];
      if (rec?.exited) return ['x', 'exited'];
      if (!rec?.started) return ['', 'not started'];
      return Date.now() - (lastData[t.id] || 0) < 2500 ? ['w', 'working'] : ['', 'idle'];
    }
    return info[t.id]?.loading ? ['w', 'loading'] : ['', 'open'];
  }
  function renderDock() {
    const dock = $('#dock'); if (dock.hidden) return;
    $('#dockcount').textContent = S.tiles.length + ' windows' + (sel.size ? ` · ${sel.size} selected` : '');
    const list = $('#alist');
    const html = S.tiles.map((t) => {
      const [cls, label] = statusOf(t);
      const sub = [TYPE(t), isChat(t) || (isTerm(t) && t.api) ? t.api.model : isTerm(t) ? t.cwd.split('/').slice(-2).join('/') : '', hidden.has(t.id) ? 'hidden' : '', label].filter(Boolean).join(' · ');
      return `<div class="arow" data-id="${t.id}"><input type="checkbox" ${sel.has(t.id) ? 'checked' : ''}><span class="st ${cls}">${cls === 'x' ? '×' : cls === 'w' ? '●' : '○'}</span><div><div class="nm2">${esc(t.name)}</div><div class="sub">${esc(sub)}</div></div></div>`;
    }).join('');
    if (list.dataset.h !== html) { list.dataset.h = html; list.innerHTML = html || '<div class="arow"><span></span><span></span><div class="sub">no windows yet</div></div>'; }
  }
  $('#alist').addEventListener('click', (e) => {
    const row = e.target.closest('.arow'); if (!row) return;
    const id = row.dataset.id;
    if (e.target.matches('input')) { e.target.checked ? sel.add(id) : sel.delete(id); renderDock(); return; }
    if (hidden.has(id)) { hidden.delete(id); render(); }
    const el = grid.querySelector(`.tile[data-id="${id}"]`); if (!el) return;
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900);
    const t = S.tiles.find((x) => x.id === id);
    if (isTerm(t)) terms[id]?.term.focus(); else if (isChat(t)) chatRef[id]?.ta.focus();
  });
  // Send one prompt to many agents: bracketed paste + Enter into terminals, a normal message into chat windows.
  function orchSend(text, ids) {
    let sent = 0, skipped = 0;
    for (const id of ids) {
      const t = S.tiles.find((x) => x.id === id); if (!t) continue;
      if (isTerm(t) && terms[id] && !terms[id].exited && terms[id].started) { api.pty.input({ id, data: '\x1b[200~' + text + '\x1b[201~' }); setTimeout(() => api.pty.input({ id, data: '\r' }), 120); sent++; }
      else if (isChat(t) && !chatBusy[id]) { sendChat(t, text); sent++; }
      else skipped++;
    }
    return { sent, skipped };
  }
  function orchestrate() {
    const ta = $('#orch'), text = ta.value.trim(); if (!text) return;
    const ids = [...sel]; if (!ids.length) { $('#onote').textContent = 'select agents first (checkboxes) or press "all"'; return; }
    const r = orchSend(text, ids);
    $('#onote').textContent = `sent to ${r.sent}` + (r.skipped ? ` · skipped ${r.skipped} (busy / exited / website)` : '');
    ta.value = '';
  }
  $('#osend').onclick = orchestrate;
  $('#orch').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); orchestrate(); } };
  $('#selall').onclick = () => { S.tiles.filter((t) => isTerm(t) || isChat(t)).forEach((t) => sel.add(t.id)); renderDock(); };
  $('#selnone').onclick = () => { sel.clear(); renderDock(); };
  const toggleDock = () => { const d = $('#dock'); d.hidden = !d.hidden; document.body.classList.toggle('dock', !d.hidden); S.dock = !d.hidden; save(); renderDock(); push(); };
  $('#agentsbtn').onclick = toggleDock;
  $('#layoutbtn').onclick = (e) => { const r = e.target.getBoundingClientRect(); api.layoutMenu({ x: r.left, y: r.bottom }); };
  if (S.dock) { $('#dock').hidden = false; document.body.classList.add('dock'); }
  setInterval(renderDock, 1000);

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
    else if (action.startsWith('snap-')) snapWindow(t, action.slice(5));
    else if (action === 'forward') {
      const last = [...(t.msgs || [])].reverse().find((m) => m.role === 'assistant' && !m.error && m.content);
      const ids = [...sel].filter((x) => x !== id);
      if (!last) return; if (!ids.length) { $('#dock').hidden && toggleDock(); $('#onote').textContent = 'select the target agents first, then use "send last answer" again'; return; }
      const r = orchSend(last.content, ids); $('#dock').hidden && toggleDock(); $('#onote').textContent = `forwarded to ${r.sent}` + (r.skipped ? ` · skipped ${r.skipped}` : '');
    }
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
      return { id: t.id, url: t.url, zoom: t.zoom, visible: !!el && !modal && !dragging && !splash, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
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
  api.on('pty:data', ({ id, data }) => { lastData[id] = Date.now(); terms[id]?.term.write(data); });
  api.on('pty:exit', ({ id }) => { const r = terms[id]; if (r) { r.exited = true; r.term.write('\r\n\x1b[90m[process exited - press any key to restart]\x1b[0m\r\n'); } });
  render();
  renderDock();
  if (api.debug) window.__ag = { applyLayout, snapWindow, orchSend, sel, S, terms, sendChat };
})();
