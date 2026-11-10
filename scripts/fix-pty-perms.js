// node-pty ships a prebuilt `spawn-helper` that must be executable; npm's script policy may skip node-pty's own postinstall.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (fs.existsSync(dir)) {
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'spawn-helper');
    if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
  }
}
