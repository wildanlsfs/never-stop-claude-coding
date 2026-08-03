# Never Stop Claude Code (`nscc`) 🚀

> Never let a 5-hour rate limit break your coding flow. Auto-rotate Claude accounts via `cux` and fall back to 9Router, OpenRouter, or DeepSeek seamlessly without losing session context.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

---

## ✨ Features & Terminal UX Best Practices

- 🎯 **Direct Fallback Flag (`nscc -f`)**: Force 9Router / OpenRouter / DeepSeek routing **immediately**, even if your Claude rate limit has not been reached yet!
- 🔇 **100% Clean Terminal Output**: Runs proxy requests silently in the background so Claude Code's interactive TUI screen is **never corrupted** by log text or flickering.
- 🔔 **Native macOS Notifications**: Receive toast banners when `nscc` auto-rotates accounts via `cux` or hot-swaps to 9Router/OpenRouter.
- 📜 **Live Proxy Logging (`nscc logs`)**: Log traffic to `~/.nscc/proxy.log`. Tail live logs in a separate split terminal using `nscc logs -f`.
- 🔄 **Multi-Account Auto-Rotation (`cux`)**: Integrates with [`inulute/cux`](https://github.com/inulute/cux) to rotate Claude Pro/Max accounts automatically on 429 rate limits.
- 🔀 **Transparent API Proxy**: Translates Anthropic's `/v1/messages` format (including system prompts, tool execution turns `tool_use`/`tool_result`, and streaming SSE events) into OpenAI `/v1/chat/completions` format.
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

---

## 🚀 Quick Start

### 1. Install Prerequisites & Link Accounts

#### Install `cux` (Required for Multi-Account Rotation)
Install `cux` globally to manage and rotate your Claude Pro/Max accounts:
```bash
npm install -g @inulute/cux
```

#### Link Your Active Claude Account to `cux`
While logged into Claude Code, add your active account to `cux`'s account pool:
```bash
cux add
```

---

### 2. Install `nscc`

Clone the repository and install dependencies:
```bash
git clone https://github.com/your-username/never-stop-claude-coding.git
cd never-stop-claude-coding
npm install
npm run build
npm link
```

---

### 3. Configure Fallback Provider

#### Option A: Use 9Router Proxy (Cloud or Local)
For 9Router Cloud:
```bash
nscc config -p 9router -u "https://9router.example.com/v1" -m "combo" -k "your-9router-api-key"
```

For 9Router Local (`http://localhost:20128/v1`):
```bash
nscc config -p 9router
```

#### Option B: Use OpenRouter
```bash
nscc config -p openrouter --api-key "sk-or-v1-your-openrouter-key" --model "deepseek/deepseek-chat"
```

---

### 4. Launch Never-Stopping Claude Code Session

#### Normal Auto Mode (Uses Claude accounts first, auto-switches to 9Router on rate limit):
```bash
nscc
```

#### Force Fallback Mode (Routes directly to 9Router / OpenRouter immediately):
```bash
nscc -f
```

---

## ⚙️ Configuration Commands

| Command | Description |
| :--- | :--- |
| `nscc` | Launch Claude Code with silent background proxy (Auto-switch on limit) |
| `nscc -f` / `nscc --fallback` | Force route directly to 9Router/OpenRouter immediately |
| `nscc config -f true` | Enable permanent direct fallback mode |
| `nscc config -f false` | Disable permanent direct fallback mode (return to auto-switch) |
| `nscc logs -f` | Tail live proxy logs in real-time |
| `nscc config -p <preset>` | Apply a provider preset (`9router`, `openrouter`, `deepseek`) |
| `nscc config -k <key>` | Set fallback API key |
| `nscc config -u <url>` | Set custom fallback base URL (e.g. `https://9router.example.com/v1`) |
| `nscc config -m <model>` | Set target fallback model |
| `nscc status` | Display status of `cux`, proxy port, and active fallback configuration |

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
