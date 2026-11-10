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
  const save = () => api.save({ tiles: S.tiles.map(({ _c, _r, _span, ...t }) => t), cols: S.cols, fr: S.fr });
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

  // ---------- layout ----------
  function render() {
    grid.innerHTML = '';
    $('#cols').value = String(S.cols || 0);
    const vis = S.tiles.filter((t) => !hidden.has(t.id) && (!max || t.id === max));
    $('#empty').hidden = S.tiles.length > 0;
    const n = vis.length || 1;
    const nc = Math.min(max ? 1 : S.cols || (n <= 2 ? n : Math.ceil(Math.sqrt(n))), n);
    const nr = Math.ceil(n / nc);
    const sig = nc + 'x' + nr;
    if (S.fr?.sig !== sig) S.fr = { sig, c: Array(nc).fill(1), r: Array(nr).fill(1) };
    const tr = (arr) => arr.map((f) => `minmax(0,${f}fr)`).join(' 5px ');
    grid.style.gridTemplateColumns = tr(S.fr.c);
    grid.style.gridTemplateRows = tr(S.fr.r);
    vis.forEach((t, i) => { t._c = i % nc; t._r = Math.floor(i / nc); t._span = i === vis.length - 1 && nc - t._c > 1; });
    for (let i = 0; i < nc - 1; i++) addGutter('v', i);
    for (let j = 0; j < nr - 1; j++) addGutter('h', j);

    for (const t of vis) {
      const el = document.createElement('div');
      el.className = 'tile'; el.dataset.id = t.id;
      el.style.gridColumn = t._span ? `${t._c * 2 + 1} / -1` : `${t._c * 2 + 1}`;
      el.style.gridRow = `${t._r * 2 + 1}`;
      const nav = isTerm(t)
        ? `<button data-c="restart" title="restart">↻</button>${t.api ? '<button data-c="cfg" title="model / key">⚙</button>' : ''}`
        : '<button data-c="back" title="back">←</button><button data-c="reload" title="reload">↻</button><button data-c="home" title="home">⌂</button>';
      el.innerHTML = `<div class="th"><span class="ld"></span><span class="nm" title="double-click to rename"></span><span class="pg"></span>${nav}
        <button data-c="zout" title="smaller">−</button><button data-c="zin" title="larger">+</button>${isTerm(t) ? '' : '<button data-c="ext" title="open in browser">↗</button>'}
        <button data-c="min" title="hide">_</button><button data-c="max" title="${max ? 'restore' : 'maximize'}">${max ? '▫' : '□'}</button><button data-c="close" title="remove">×</button></div><div class="body"></div>`;
      el.querySelector('.nm').textContent = t.name;
      el.querySelector('.nm').ondblclick = () => rename(t);
      if (isTerm(t)) el.querySelector('.pg').textContent = (t.api ? t.api.model + ' · ' : '') + TOOL[t.cmd] + ' · ' + t.cwd;
      el.querySelector('.th').addEventListener('click', (e) => onHeaderClick(e, t));
      grid.appendChild(el);
      if (isTerm(t)) mountTerm(t, el.querySelector('.body')); else paintInfo(t.id);
    }
    chips();
    push();
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

  function addGutter(dir, i) {
    const g = document.createElement('div');
    g.className = 'gut ' + dir;
    if (dir === 'v') g.style.gridColumn = String(i * 2 + 2); else g.style.gridRow = String(i * 2 + 2);
    g.onpointerdown = (e) => {
      e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('drag'); dragging = true; grid.classList.add('dragging'); push();
      const arr = dir === 'v' ? S.fr.c : S.fr.r;
      const total = arr.reduce((a, b) => a + b, 0);
      const px = (dir === 'v' ? grid.clientWidth : grid.clientHeight) - 5 * (arr.length - 1);
      const start = dir === 'v' ? e.clientX : e.clientY, a0 = arr[i], b0 = arr[i + 1];
      g.onpointermove = (ev) => {
        const d = ((dir === 'v' ? ev.clientX : ev.clientY) - start) / px * total;
        const min = total * 0.08;
        const na = Math.min(a0 + b0 - min, Math.max(min, a0 + d));
        arr[i] = na; arr[i + 1] = a0 + b0 - na;
        grid.style[dir === 'v' ? 'gridTemplateColumns' : 'gridTemplateRows'] = arr.map((f) => `minmax(0,${f}fr)`).join(' 5px ');
      };
      g.onpointerup = () => { g.onpointermove = g.onpointerup = null; g.classList.remove('drag'); grid.classList.remove('dragging'); dragging = false; save(); push(); };
    };
    grid.appendChild(g);
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
  $('#cols').onchange = (e) => { S.cols = +e.target.value; save(); render(); };
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
