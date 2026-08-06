# Never Stop Claude Code (`nscc`) 🚀

> Never let a 5-hour rate limit break your coding flow. Auto-rotate Claude accounts via `cux` and fall back to 9Router, OpenRouter, or DeepSeek seamlessly without losing session context.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

> **⚠️ Unofficial community project.** `nscc` is not affiliated with, endorsed by, or supported by Anthropic. It works by running a local proxy in front of the official `claude` CLI — use it at your own discretion, and make sure your usage complies with the Terms of Service of every account/provider you connect through it.

---

## ✨ Features & Terminal UX Best Practices

- 🎯 **Direct Fallback Flag (`nscc -f`)**: Force 9Router / OpenRouter / DeepSeek routing **immediately**, even if your Claude rate limit has not been reached yet!
- 🔇 **100% Clean Terminal Output**: Runs proxy requests silently in the background so Claude Code's interactive TUI screen is **never corrupted** by log text or flickering.
- 🔔 **Native macOS Notifications**: Receive toast banners when `nscc` auto-rotates accounts via `cux` or hot-swaps to 9Router/OpenRouter (macOS only — see [Platform Support](#-platform-support)).
- 📜 **Live Proxy Logging (`nscc logs`)**: Log traffic to `~/.nscc/proxy.log`. Tail live logs in a separate split terminal using `nscc logs -f`.
- 🔄 **Multi-Account Auto-Rotation (`cux`)**: Integrates with [`inulute/cux`](https://github.com/inulute/cux) to rotate Claude Pro/Max accounts automatically on 429 rate limits.
- 🔀 **Transparent API Proxy**: Translates Anthropic's `/v1/messages` format (including system prompts, tool execution turns `tool_use`/`tool_result`, and streaming SSE events) into OpenAI `/v1/chat/completions` format, and back.
- 🌐 **First-Class 9Router Support**: Native presets for **9Router** (local `http://localhost:20128/v1` or cloud instance), **OpenRouter**, **DeepSeek**, and custom OpenAI-compatible endpoints.
- 🛡️ **Zero Context Loss**: Intercepts rate limits at the local proxy level before Claude Code sees the error, preserving your full prompt history and conversation state.

---

## 🏗️ Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │              Claude Code CLI                 │
                       │    (ANTHROPIC_BASE_URL=http://localhost:3456)│
                       └──────────────────────┬───────────────────────┘
                                              │
                                     [ Active Session ]
                                              │
                       ┌──────────────────────▼───────────────────────┐
                       │          nscc Local Proxy Server             │
                       │               (Port 3456)                    │
                       └──────┬──────────────────────┬─────────▲──────┘
                              │                      │         │ 429 Rate Limit
                     Tier 1   │             Tier 2   │         │ (Intercepted)
                              ▼                      ▼         │
                      ┌──────────────┐       ┌─────────────────┴──────────┐
                      │  cux Engine  │       │  Anthropic <-> OpenAI      │
                      │ (Claude OAuth│       │  Protocol Translator       │
                      │ Accounts)    │       │ (9Router / OpenRouter /    │
                      └──────────────┘       │  DeepSeek / Custom API)    │
                                             └────────────────────────────┘
```

`nscc` never talks to Anthropic on your behalf with new credentials — it launches the `claude` CLI you already have installed and authenticated, and simply points its `ANTHROPIC_BASE_URL` at a local proxy. That proxy tries your real Anthropic account first, and only reaches out to a fallback provider (9Router / OpenRouter / DeepSeek / any OpenAI-compatible endpoint) when your account is rate-limited or you explicitly force it to.

---

## ✅ Prerequisites

Before installing `nscc`, make sure you have:

1. **[Node.js](https://nodejs.org/) v18 or newer** (`node -v` to check) and npm.
2. **[Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in.** `nscc` wraps the official `claude` CLI — it does not replace it.
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
3. **(Optional) A fallback provider account** if you want automatic failover when you hit a rate limit — an API key from [9Router](https://9router.com), [OpenRouter](https://openrouter.ai), [DeepSeek](https://platform.deepseek.com), or any other OpenAI-compatible endpoint.
4. **(Optional) [`cux`](https://github.com/inulute/cux)** if you want to rotate between multiple Claude Pro/Max accounts automatically on 429s (see [Multi-Account Rotation](#multi-account-rotation-optional) below).

---

## 🚀 Quick Start

### 1. Install `nscc`

Clone the repository and install dependencies:
```bash
git clone https://github.com/wildanlsfs/never-stop-claude-coding.git
cd never-stop-claude-coding
npm install
npm run build
npm link
```

`npm link` makes the `nscc` command available globally. Verify it worked:
```bash
nscc status
```

---

### 2. Configure a Fallback Provider

You need at least one fallback provider configured so `nscc` has somewhere to go when your Claude account hits a rate limit (or when you use `-f` to force it).

#### Option A: 9Router (Cloud or Local)
For 9Router Cloud:
```bash
nscc config -p 9router -u "https://9router.example.com/v1" -m "combo" -k "your-9router-api-key"
```

For 9Router Local (`http://localhost:20128/v1`, e.g. running 9Router yourself):
```bash
nscc config -p 9router
```

#### Option B: OpenRouter
```bash
nscc config -p openrouter --api-key "sk-or-v1-your-openrouter-key" --model "deepseek/deepseek-chat"
```

#### Option C: DeepSeek or any custom OpenAI-compatible endpoint
```bash
nscc config -p deepseek -k "your-deepseek-api-key"
# or fully custom:
nscc config -u "https://your-endpoint.example.com/v1" -k "your-api-key" -m "your-model-id"
```

Not sure which model ID to use? List what your provider currently offers:
```bash
nscc models
```

---

### 3. Launch a Never-Stopping Claude Code Session

#### Normal Auto Mode (uses your Claude account first, auto-switches to the fallback provider only on a rate limit):
```bash
nscc
```

#### Force Fallback Mode (routes directly to your fallback provider immediately, skipping Anthropic):
```bash
nscc -f
```

Any arguments you'd normally pass to `claude` can be passed through `nscc` directly, e.g. `nscc --print "explain this repo"`.

---

## 🔁 Multi-Account Rotation (Optional)

If you have multiple Claude Pro/Max accounts and want `nscc` to auto-rotate between them on a 429 before ever falling back to another provider:

```bash
npm install -g @inulute/cux
cux add   # run once per account, while logged into that account in Claude Code
```

`nscc` detects `cux` automatically and will rotate accounts first, only reaching for your configured fallback provider if every account in the pool is also rate-limited.

---

## ⚙️ Configuration Commands

| Command | Description |
| :--- | :--- |
| `nscc` | Launch Claude Code with silent background proxy (auto-switch on limit) |
| `nscc -f` / `nscc --fallback` | Force route directly to the fallback provider immediately for this session |
| `nscc -c` / `nscc --auto-continue` | Auto re-inject "continue" when Claude Code (or the fallback model) stops mid-task |
| `nscc config -f true` | Enable permanent direct fallback mode |
| `nscc config -f false` | Disable permanent direct fallback mode (return to auto-switch on 429) |
| `nscc config -p <preset>` | Apply a provider preset (`9router`, `openrouter`, `deepseek`) |
| `nscc config -k <key>` | Set fallback API key |
| `nscc config -u <url>` | Set custom fallback base URL (e.g. `https://9router.example.com/v1`) |
| `nscc config -m <model>` | Set target fallback model |
| `nscc config --port <port>` | Set the local proxy port (default `3456`) |
| `nscc config -v true` \| `false` | Persist verbose proxy logging on/off |
| `nscc status` | Display status of `cux`, proxy port, and active fallback configuration |
| `nscc models` | Fetch & list all available models from the configured fallback provider |
| `nscc models --set <model_id>` | Set and save the active fallback model |
| `nscc logs` | Print the proxy log file (`~/.nscc/proxy.log`) |
| `nscc logs -f` | Tail live proxy logs in real-time |
| `nscc proxy --port <port>` | Run the proxy server standalone in the foreground (mainly for debugging) |

All configuration is stored in `~/.nscc/config.json`. See [Security Note](#-security-note) below before sharing that file or your dotfiles.

---

## ⚠️ Known Limitations & Model Selection Guide

When using **Force Fallback Mode** (`nscc -f`) with 9Router, OpenRouter, or a custom endpoint, the reliability of autonomous tool execution depends heavily on the chosen fallback model.

### 1. Model Tool-Calling Adherence (Function Calling)
- **Rotator & free/flash-tier models** are often optimized for chat responses and may summarize tool output in plain text, returning `finish_reason: "stop"` instead of issuing structured `tool_calls` JSON. This can cause Claude Code to halt mid-task.
- **Output Compression / Caveman Mode**: 9Router features output compression ("Caveman mode"), which converts tool call JSON into plain text summaries. `nscc` automatically passes `caveman: false` for 9Router endpoints to preserve tool call schemas.
- **Choosing a model**: prefer models explicitly documented as supporting OpenAI-style function calling / tool use. Run `nscc models` to see what your configured provider currently offers, and prefer full-size coding/agentic models over free or "flash" tiers when running multi-step tool loops — provider catalogs change often, so treat any specific model name as a starting point to test, not a guarantee.
- If a model keeps replying in plain text instead of calling tools, `nscc` will automatically retry once with `tool_choice: "required"` before giving up and injecting a keepalive no-op so your session doesn't hang — check `nscc logs -f` for `[auto-retry]` / `[synthetic-continue]` lines to see this happening live.

### 2. Auto-Continue Mode (`-c` / `--auto-continue`)
If a fallback model halts mid-task by returning a text summary instead of a tool call, `nscc -c` automatically re-injects task context to re-anchor the model into continuing the execution loop.

---

## 🖥️ Platform Support

`nscc` itself is a Node.js CLI and runs anywhere Node 18+ and the `claude` CLI run (macOS, Linux, Windows). Two features are currently more limited:

- **Desktop notifications** (`Logger.notify`) use `osascript` and only fire on **macOS**. On other platforms `nscc` still works — you just won't get the toast banners; use `nscc logs -f` to watch events instead.
- **`cux` account rotation** relies on the `which` command to detect installation. This works out of the box on macOS/Linux; on native Windows, run `nscc` under WSL or Git Bash for `cux` rotation to be detected.

---

## 🔒 Security Note

`nscc` stores your fallback provider API key **in plaintext** at `~/.nscc/config.json` (and, separately, `cux` manages your Claude OAuth sessions). Treat this file like a credentials file:

- Don't commit it, share it, or paste its contents when asking for help.
- `nscc status` masks your key (showing only the last 4 characters) — prefer that over `cat`-ing the config file when troubleshooting in public.
- If a key ever leaks, rotate it with your provider immediately and re-run `nscc config -k <new-key>`.

---

## 🩺 Troubleshooting

- **Tool calls / agent loop seem to stall or hang when using the fallback provider**: run `nscc logs -f` in a second terminal while reproducing the issue. Look for `[auto-retry]` or `[synthetic-continue]` — these indicate the fallback *model* isn't reliably returning tool calls (see [Model Selection Guide](#-known-limitations--model-selection-guide) above), which is usually fixed by switching to a stronger/full-size model via `nscc models --set <model_id>`.
- **`nscc: command not found`**: re-run `npm link` from the repo directory, or confirm your npm global bin directory is on your `PATH` (`npm config get prefix`).
- **Proxy port already in use**: `nscc` will attempt to free a stale process on its configured port automatically; if it still fails, change the port with `nscc config --port <new-port>`.
- **Nothing happens / immediate error on launch**: confirm the `claude` CLI is installed and you're logged in (`claude login`) — `nscc` launches `claude` as a subprocess and can't do anything if it isn't on your `PATH`.
- **Still stuck?** Open an issue with the output of `nscc status` (key redacted) and the relevant lines from `~/.nscc/proxy.log`.

---

## 🤝 Contributing

Issues and pull requests are welcome at [github.com/wildanlsfs/never-stop-claude-coding](https://github.com/wildanlsfs/never-stop-claude-coding). Before opening a PR:

```bash
npm install
npm test        # vitest — please keep this green
npm run build   # tsc — must compile clean
```

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
