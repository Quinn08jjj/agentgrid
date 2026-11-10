# AgentGrid

**Run many AI coding agents side by side — each with its own account.**
Claude Code, Codex and chat windows for DeepSeek, Kimi, GLM, Qwen, Grok, OpenAI, Anthropic and local Ollama models in one minimal black-and-white tiling workspace for macOS. No logging out, no account switching, no extra VS Code windows.

![AgentGrid with DeepSeek, Kimi and GLM chat windows next to a Codex window](docs/screenshot.png)

## Why

- Claude Code and Codex support **one account per window**. If you have two Claude accounts and three ChatGPT accounts, you end up logging out and in, or juggling terminals.
- Third-party coding models (Kimi, DeepSeek, GLM, Qwen, local models) need environment variables and endpoint juggling every time.
- Chat sites such as claude.ai and chatgpt.com can't be embedded in VS Code with separate logins.

AgentGrid gives every window its **own isolated login** and lets you drag them into any layout.

## Features

- **Unlimited parallel accounts** — e.g. 3× Claude Code with 3 different accounts next to 2× Codex.
- **Real tools, not look-alikes** — each tile is the actual `claude`, `codex` or `opencode` CLI in a real pty (xterm.js), working in the project folder you choose.
- **Native chat windows for every provider** — DeepSeek, Kimi, GLM, Qwen, Grok, OpenAI, Anthropic, Ollama or any OpenAI-compatible endpoint. Your API key talks directly to that provider; the answer is that model, with its own plain interface (streaming, reasoning, code blocks). The model list is fetched from the provider's API, so you pick real model ids.
- **Coding agents with any provider** — the same providers can also run as an [opencode](https://opencode.ai) agent that reads and edits files in your project folder.
- **Chat websites as tiles too** — Claude, ChatGPT, Kimi, Qwen, DeepSeek, GLM, Gemini, Grok, Perplexity, Le Chat or any URL. Every site tile has its own persistent cookie jar, so the same site can be open with several accounts.
- **Free-form windows** — drag a title bar to move a window and drop it on another one to swap places; drag any edge or corner to resize just that window. Windows snap to neighbours and borders and never overlap. One click re-tiles everything into a grid.
- Maximize/hide per window, per-window text zoom, auto grid or fixed column count.
- **Keys stay local** — API keys are encrypted with the macOS keychain (Electron `safeStorage`). No telemetry, no server.
- Minimal by design: black, white, monospace.

## Supported agents

| Window | What it is | Account / auth |
|---|---|---|
| Claude Code | the real `claude` CLI | Subscription login (separate config folder per window) |
| Codex | the real `codex` CLI | ChatGPT login (separate `CODEX_HOME` per window) |
| Chat · DeepSeek, Kimi, GLM, Qwen, Grok, OpenAI | native chat window, direct API calls | API key |
| Chat · Anthropic | native chat window (Messages API) | API key |
| Chat · Ollama / custom | native chat window, any OpenAI-compatible endpoint | none / API key |
| Coding agent · any of the above | [opencode](https://opencode.ai) in your project folder | API key / none |
| Websites | claude.ai, chatgpt.com, kimi.com, … | Own login per window |

When you add a provider, the app asks the API for its model list and lets you pick one (⋯ → settings changes it later).

## Install

**Download** the latest `AgentGrid-macos-arm64.zip` from [Releases](https://github.com/Quinn08jjj/agentgrid/releases), unzip, move `AgentGrid.app` to Applications. The app is not notarized: right-click → *Open* the first time.

**From source** (also for Intel Macs):

```bash
git clone https://github.com/Quinn08jjj/agentgrid.git
cd agentgrid
npm install
npm start          # or: npm run build  → dist/AgentGrid-darwin-*/AgentGrid.app
```

Requirements: macOS, Node 20+ (source builds). Claude Code must be installed for Claude tiles; Codex and opencode are installed on demand into `~/.agentgrid/tools` (no global installs).

## Usage

1. Click **+ new** and pick an agent.
2. For Claude Code / Codex choose *New separate login* (own folder → own account) or *Existing login*, then pick the project folder.
3. For *Chat via API key* enter name and key, then choose the model from the list. For *Coding agent via API key* you additionally pick the project folder.
4. Drag a window's title bar to move it (drop it on another window to swap), its edges or corners to resize it. The **⋯** menu has rename, text size, settings. **tile** re-arranges everything into a grid.

### Open it from VS Code

`vscode/` contains a tiny launcher extension: `Cmd+Shift+D` opens AgentGrid. Install with
`cd vscode && npx @vscode/vsce package && code --install-extension agentgrid-launcher-*.vsix`.

## How it works

- Claude Code windows set `CLAUDE_CONFIG_DIR` per window, Codex windows set `CODEX_HOME` per window — each folder holds its own credentials, history and settings.
- Chat windows call the provider's `/chat/completions` (or Anthropic `/v1/messages`) endpoint from the app's main process; the key is read from the encrypted store there and never reaches the UI.
- Coding-agent windows start opencode with a per-window config and data folder.
- Website tiles are Electron `WebContentsView`s with a dedicated `persist:` session partition each.
- Terminals are `node-pty` + xterm.js. Everything is stored under `~/Library/Application Support/AgentGrid` and `~/.agentgrid`.

## Limitations

- Built and tested on macOS (Apple Silicon). Windows/Linux are not supported yet.
- Chat windows are plain chat (no file access). Use a coding-agent window for editing files. Provider endpoints were taken from public docs and may change.
- "Sign in with Google" is often blocked inside embedded browsers; use email login in website tiles.
- Please check each provider's terms before running several accounts in parallel. AgentGrid is an unofficial tool and is not affiliated with Anthropic, OpenAI, Moonshot, DeepSeek, Zhipu, Alibaba or xAI.

## Alternatives

Looking for something different? These projects solve related problems: [mcode](https://github.com/roman10/mcode) (tiling IDE for agent sessions), [clauth](https://docs.rs/crate/clauth) (terminal account switcher), [claude-swap](https://github.com/realiti4/claude-swap), [claude-multiprofile](https://github.com/jmdarre-v/claude-multiprofile). AgentGrid's focus is *many accounts and providers visible at once*, minimal UI, and mixing CLI agents with chat websites.

## FAQ

**How do I use two Claude Code accounts at the same time?**
Add two *Claude Code* tiles and choose *New separate login* for each; log in once inside each tile.

**How do I run multiple Codex / ChatGPT accounts in parallel?**
Same: one *Codex* tile per account, each with its own `CODEX_HOME`.

**Can I chat with DeepSeek / Kimi / GLM / Qwen / Grok with my own API key?**
Yes — *Chat via API key*. Each window talks only to that provider and answers as that model.

**Can they edit my code like Claude Code?**
Yes — add them under *Coding agent via API key*; that runs opencode against the provider.

**Can I use a local model?**
Yes: choose *Local model (Ollama)* (chat or coding agent) with a model pulled in Ollama.

**Does it send my keys or code anywhere?**
No server, no telemetry. Keys are encrypted by the OS keychain; traffic goes straight from the tool to the provider you configured.

## License

[MIT](LICENSE)
