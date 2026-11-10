(async function () {
  const $ = (s) => document.querySelector(s);
  const grid = $('#grid');
  const S = (await window.grid.load()) || { tiles: [], cols: 0 };
  const api = window.grid;
  S.tiles.forEach((t) => { t.zoom = t.zoom || 1; });
  let modal = false, dragging = false, max = null;
  const hidden = new Set();
  const info = {};
  const terms = {};
  const uid = () => Math.random().toString(36).slice(2, 8);
  const isTerm = (t) => t.kind === 'term';
  const save = () => api.save({ tiles: S.tiles, cols: S.cols, auto: S.auto });
  const TOOL = { claude: 'claude code', codex: 'codex', opencode: 'opencode' };

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
  function restartPty(t) {
    const rec = getTerm(t); api.pty.kill({ id: t.id }); rec.term.reset(); setTimeout(() => startPty(t, rec), 250);
  }
  function mountTerm(t, body) {
    const rec = getTerm(t);
    if (!rec.term.element) rec.term.open(body); else body.appendChild(rec.term.element);
    body.classList.add('term');
    const doFit = () => { try { rec.fit.fit(); } catch {} };
    requestAnimationFrame(() => { doFit(); if (!rec.started) startPty(t, rec); rec.term.focus(); });
    new ResizeObserver(doFit).observe(body);
  }

  // ---------- layout (free-form: every tile has its own box, in fractions of the area) ----------
  const EPS = 0.0005;
  const overlap = (a, b) => a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
  const visibleTiles = () => S.tiles.filter((t) => !hidden.has(t.id) && (!max || t.id === max));

  function arrange(vis) {
    const n = vis.length || 1;
    const nc = Math.min(S.cols || (n <= 2 ? n : Math.ceil(Math.sqrt(n))), n);
    const nr = Math.ceil(n / nc);
    vis.forEach((t, i) => {
      const r = Math.floor(i / nc), cnt = Math.min(nc, n - r * nc), c = i - r * nc;
      t.box = { x: c / cnt, y: r / nr, w: 1 / cnt, h: 1 / nr };
    });
    S.auto = true;
  }
  // Tiles without a box: re-tile everything while the user never customized, else split the largest tile.
  function ensureBoxes(vis) {
    const sig = vis.map((t) => t.id).join(',');
    if (S.auto !== false && (S.sig !== sig || vis.some((t) => !t.box))) { arrange(vis); S.sig = sig; return; }
    for (const t of vis) {
      if (t.box) continue;
      const placed = vis.filter((x) => x.box);
      if (!placed.length) { t.box = { x: 0, y: 0, w: 1, h: 1 }; continue; }
      const big = placed.reduce((m, x) => (x.box.w * x.box.h > m.box.w * m.box.h ? x : m));
      const bx = big.box;
      if (bx.w * grid.clientWidth >= bx.h * grid.clientHeight) { const h = bx.w / 2; t.box = { x: bx.x + h, y: bx.y, w: h, h: bx.h }; big.box = { ...bx, w: h }; }
      else { const h = bx.h / 2; t.box = { x: bx.x, y: bx.y + h, w: bx.w, h }; big.box = { ...bx, h }; }
    }
    S.sig = sig;
  }

  function place(el, t) {
    const b = max ? { x: 0, y: 0, w: 1, h: 1 } : t.box;
    el.style.left = b.x * 100 + '%'; el.style.top = b.y * 100 + '%'; el.style.width = b.w * 100 + '%'; el.style.height = b.h * 100 + '%';
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
      place(el, t);
      const nav = isTerm(t)
        ? `<button data-c="restart" title="restart">↻</button>${t.api ? '<button data-c="cfg" title="model / key">⚙</button>' : ''}`
        : '<button data-c="back" title="back">←</button><button data-c="reload" title="reload">↻</button><button data-c="home" title="home">⌂</button>';
      el.innerHTML = `<div class="in"><div class="th"><span class="ld"></span><span class="nm" title="double-click to rename · drag the bar to move"></span><span class="pg"></span>${nav}
        <button data-c="zout" title="smaller text">−</button><button data-c="zin" title="larger text">+</button>${isTerm(t) ? '' : '<button data-c="ext" title="open in browser">↗</button>'}
        <button data-c="min" title="hide">_</button><button data-c="max" title="${max ? 'restore' : 'maximize'}">${max ? '▫' : '□'}</button><button data-c="close" title="remove">×</button></div><div class="body"></div></div>`
        + (max ? '' : ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<i class="rz ${d}" data-d="${d}"></i>`).join(''));
      el.querySelector('.nm').textContent = t.name;
      el.querySelector('.nm').ondblclick = () => rename(t);
      if (isTerm(t)) el.querySelector('.pg').textContent = (t.api ? t.api.model + ' · ' : '') + TOOL[t.cmd] + ' · ' + t.cwd;
      el.querySelector('.th').addEventListener('click', (e) => onHeaderClick(e, t));
      if (!max) {
        el.querySelector('.th').onpointerdown = (e) => { if (e.target.closest('button')) return; startDrag(e, t, el, 'move', e.currentTarget); };
        el.querySelectorAll('.rz').forEach((h) => { h.onpointerdown = (e) => startDrag(e, t, el, h.dataset.d, h); });
      }
      grid.appendChild(el);
      if (isTerm(t)) mountTerm(t, el.querySelector('.body')); else paintInfo(t.id);
    }
    chips();
    push();
  }

  // Move (drag the title bar) or resize (drag an edge/corner). Snaps to other tiles and the borders, never overlaps.
  function startDrag(e, t, el, mode, handle) {
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    dragging = true; el.classList.add('active'); push();
    const W = grid.clientWidth, H = grid.clientHeight;
    const start = { ...t.box }, px = e.clientX, py = e.clientY;
    const others = visibleTiles().filter((x) => x.id !== t.id).map((x) => x.box);
    const thr = 8;
    const xs = [0, 1, ...others.flatMap((o) => [o.x, o.x + o.w])], ys = [0, 1, ...others.flatMap((o) => [o.y, o.y + o.h])];
    const snap = (v, lines, size) => { for (const l of lines) if (Math.abs(v - l) * size < thr) return l; return v; };
    const minW = 150 / W, minH = 90 / H;
    let last = { ...start };
    handle.onpointermove = (ev) => {
      const dx = (ev.clientX - px) / W, dy = (ev.clientY - py) / H;
      let { x, y, w, h } = start;
      if (mode === 'move') {
        x = Math.min(1 - w, Math.max(0, x + dx)); y = Math.min(1 - h, Math.max(0, y + dy));
        const sx = snap(x, xs, W), sr = snap(x + w, xs, W); x = sx !== x ? sx : sr !== x + w ? sr - w : x;
        const sy = snap(y, ys, H), sb = snap(y + h, ys, H); y = sy !== y ? sy : sb !== y + h ? sb - h : y;
      } else {
        let l = x, r = x + w, tp = y, bt = y + h;
        if (mode.includes('w')) l = Math.min(r - minW, Math.max(0, snap(l + dx, xs, W)));
        if (mode.includes('e')) r = Math.max(l + minW, Math.min(1, snap(r + dx, xs, W)));
        if (mode.includes('n')) tp = Math.min(bt - minH, Math.max(0, snap(tp + dy, ys, H)));
        if (mode.includes('s')) bt = Math.max(tp + minH, Math.min(1, snap(bt + dy, ys, H)));
        x = l; y = tp; w = r - l; h = bt - tp;
      }
      const cand = { x, y, w, h };
      // collision: try the full move, then each axis alone so the tile can slide along neighbours
      const free = (b) => !others.some((o) => overlap(b, o));
      const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });
      const toward = (from, to) => { if (free(to)) return to; let lo = 0, hi = 1; for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (free(lerp(from, to, mid))) lo = mid; else hi = mid; } return lerp(from, to, lo); };
      let use = toward(last, cand); // stop exactly at the neighbour instead of refusing the move
      if (mode === 'move' && use !== cand) {
        // slide along a neighbour: try each axis on its own
        const sx = toward(last, { ...cand, y: last.y }), sy = toward(last, { ...cand, x: last.x });
        use = Math.abs(sx.x - last.x) >= Math.abs(sy.y - last.y) ? sx : sy;
      }
      if (!use) return;
      use = { x: Math.max(0, use.x), y: Math.max(0, use.y), w: use.w, h: use.h };
      last = use; t.box = use; place(el, t);
    };
    handle.onpointerup = () => {
      handle.onpointermove = handle.onpointerup = null; el.classList.remove('active'); dragging = false;
      S.auto = false; save(); push();
    };
  }

  function onHeaderClick(e, t) {
    const c = e.target.dataset.c; if (!c) return;
    if (c === 'back' || c === 'reload' || c === 'home') api.cmd({ id: t.id, cmd: c, url: t.url });
    else if (c === 'restart') restartPty(t);
    else if (c === 'cfg') editApi(t);
    else if (c === 'ext') api.cmd({ id: t.id, cmd: 'external' });
    else if (c === 'zin' || c === 'zout') {
      t.zoom = c === 'zin' ? Math.min(2, +(t.zoom + 0.1).toFixed(2)) : Math.max(0.4, +(t.zoom - 0.1).toFixed(2)); save();
      if (isTerm(t)) { const r = getTerm(t); r.term.options.fontSize = Math.round(13 * t.zoom); try { r.fit.fit(); } catch {} } else push();
    }
    else if (c === 'min') { hidden.add(t.id); render(); }
    else if (c === 'max') { max = max ? null : t.id; render(); }
    else if (c === 'close') api.remove({ id: t.id, name: t.name, term: isTerm(t) }).then((ok) => {
      if (!ok) return;
      if (isTerm(t)) { api.pty.kill({ id: t.id }); terms[t.id]?.term.dispose(); delete terms[t.id]; }
      S.tiles = S.tiles.filter((x) => x.id !== t.id); hidden.delete(t.id); if (max === t.id) max = null; save(); render();
    });
  }

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

  // Report placeholder rectangles; the main process lays the real web views on top.
  function push() {
    const web = S.tiles.filter((t) => !isTerm(t));
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
  // fields: [{k,label,value,type,placeholder} | {note}] -> Promise<{k:value}|null>
  function ask(title, fields) {
    return new Promise((res) => {
      modal = true; push();
      $('#mtitle').textContent = title;
      const box = $('#mfields'); box.innerHTML = '';
      fields.forEach((f) => {
        if (f.note) { const n = document.createElement('div'); n.className = 'note'; n.textContent = f.note; box.appendChild(n); return; }
        const l = document.createElement('label'); l.textContent = f.label;
        const i = document.createElement('input'); i.type = f.type || 'text'; i.value = f.value || ''; i.placeholder = f.placeholder || ''; i.autocomplete = 'off'; i.dataset.k = f.k;
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
  async function addApi(p) {
    const fields = [{ k: 'name', label: 'name', value: p.label.replace(/ \(.*\)/, '') }];
    if (p.askUrl) fields.push({ k: 'baseUrl', label: 'base url', value: p.baseUrl });
    fields.push({ k: 'model', label: 'model', value: p.model, placeholder: 'model id of the provider' });
    if (p.noKey) fields.push({ note: 'No key needed. Ollama must be running with the model pulled.' });
    else fields.push({ k: 'key', label: 'api key', type: 'password' }, { note: 'Stored encrypted in the macOS keychain.' });
    const r = await ask(p.label, fields);
    if (!r || !r.model || (!p.noKey && !r.key)) return;
    const cwd = await api.pickFolder(r.name); if (!cwd) return;
    const id = uid();
    if (r.key) api.setKey({ id, key: r.key });
    S.tiles.push({ id, kind: 'term', cmd: p.tool, name: r.name + ' · ' + (cwd.split('/').filter(Boolean).pop() || cwd), cwd, zoom: 1,
      configDir: p.tool === 'claude' ? `${p.home}/claude-${id}` : '',
      api: { provider: p.id, label: r.name, baseUrl: r.baseUrl || p.baseUrl, model: r.model, noKey: !!p.noKey } });
    max = null; save(); render();
  }
  async function editApi(t) {
    const fields = [{ k: 'model', label: 'model', value: t.api.model }, { k: 'baseUrl', label: 'base url', value: t.api.baseUrl }];
    if (!t.api.noKey) fields.push({ k: 'key', label: 'new api key (empty = keep)', type: 'password' });
    const r = await ask('settings · ' + t.name, fields); if (!r) return;
    if (r.model) t.api.model = r.model;
    if (r.baseUrl) t.api.baseUrl = r.baseUrl;
    if (r.key) api.setKey({ id: t.id, key: r.key });
    save(); restartPty(t);
  }

  $('#add').onclick = (e) => { const r = e.target.getBoundingClientRect(); api.addMenu({ x: r.left, y: r.bottom }); };
  $('#add2').onclick = () => api.addMenu({ x: innerWidth / 2 - 60, y: innerHeight / 2 });
  const retile = () => { visibleTiles().forEach((t) => delete t.box); S.auto = true; S.sig = ''; save(); render(); };
  $('#cols').onchange = (e) => { S.cols = +e.target.value; retile(); };
  $('#tile').onclick = retile;
  $('#restoreAll').onclick = () => { hidden.clear(); max = null; render(); };
  api.on('tile:add', ({ name, url }) => addWeb(name, url));
  api.on('tile:addTerm', addTerm);
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
