# Contributing

Thanks for helping! AgentGrid is intentionally small: three source files and no build step.

```bash
git clone https://github.com/Quinn08jjj/agentgrid.git
cd agentgrid
npm install
npm start            # run from source
npm run check        # syntax check
npm run build        # package AgentGrid.app into dist/
```

- `src/main.js` – windows, web views, pty processes, key storage, provider presets
- `src/preload.js` – the small IPC bridge
- `src/renderer/` – the tiling UI (plain JS + xterm.js, no framework)

Guidelines: keep it dependency-light, keep the UI black and white and monospace, never log or transmit API keys.
Provider presets (endpoints and default model ids) live in `API_PRESETS` in `src/main.js`; model ids change often, so PRs that update them are very welcome.
