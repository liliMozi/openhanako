<p align="center">
  <img src=".github/assets/banner.jpg" width="100%" alt="OpenHanako Banner">
</p>

<p align="center">
  <img src=".github/assets/Hanako-280.png" width="80" alt="Hanako">
</p>

<h1 align="center">OpenHanako</h1>

<p align="center">A personal AI agent with memory and soul</p>

<p align="center"><a href="README_CN.md">中文版</a></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](https://github.com/liliMozi/openhanako/releases)

---

## What is Hanako

OpenHanako is a personal AI agent that is easier to use than traditional coding agents. It has memory, personality, and can act autonomously. Multiple agents can work together on your machine.

As an assistant, it is gentle: no complex configuration files, no obscure jargon. Hanako is designed not just for coders, but for everyone who works at a computer.
As a tool, it is powerful: it remembers everything you've said, operates your computer, browses the web, searches for information, reads and writes files, executes code, manages schedules, and can even learn new skills on its own.

## Features

**Memory** — A custom memory system that keeps recent events sharp and lets older ones fade naturally.

**Personality** — Not a generic "AI assistant". Each agent has its own voice and behavior through personality templates. Agents are self-contained folders, easy to back up and manage.

**Tools** — Read/write files, run terminal commands, browse the web, search the internet, take screenshots, draw on a canvas, execute JavaScript. Covers the vast majority of daily work scenarios.

**Skills** — Built-in compatibility with the community Skills ecosystem. Agents can also install skills from GitHub or write their own. Strict safety review enabled by default.

**Multi-Agent** — Create multiple agents, each with independent memory, personality, and scheduled tasks. Agents can collaborate via channel group chats or delegate tasks to each other.

**Desk** — Each agent has a desk for files and notes (Jian). Supports drag-and-drop, file preview, and serves as an async collaboration space between you and your agent.

**Full-Screen Media Viewer** — Click any image, SVG, or video from chat or the desk to open a dark-overlay viewer with wheel-zoom, drag-to-pan, `+` / `−` / `0` shortcuts, and left/right navigation between sibling media in the same session or folder.

**Cron & Heartbeat** — Agents can run scheduled tasks and periodically check for file changes on the desk. They work autonomously even when you're away.

**Sandbox** — Two-layer isolation: application-level PathGuard with four access tiers + OS-level sandboxing (macOS Seatbelt / Linux Bubblewrap).

**Plugins** — Extensible plugin system with a convention-first architecture. Install community plugins by drag-and-drop. Plugins can contribute tools, skills, commands, agent templates, HTTP routes, event hooks, and LLM providers. Routes have direct access to core services (PluginContext injection) and can interact with agent sessions via the Session Bus (send messages, get history, list sessions). Two-level permission model (restricted / full-access) keeps things safe.

**Multi-Platform Bridge** — A single agent can connect to Telegram, Feishu, QQ, and WeChat bots simultaneously. Chat from any platform and remotely operate your computer.

**i18n** — Interface available in 5 languages: Chinese, English, Japanese, Korean, and Traditional Chinese.

## Screenshots

<p align="center">
  <img src=".github/assets/screenshot-main.jpg" width="100%" alt="Hanako Main Interface">
</p>

## Quick Start

### Download

**macOS (Apple Silicon / Intel):** download the latest `.dmg` from [Releases](https://github.com/liliMozi/openhanako/releases).

The app is signed and notarized with an Apple Developer ID. macOS should allow it to launch directly.

**Windows:** download the latest `.exe` installer from [Releases](https://github.com/liliMozi/openhanako/releases).

> **Windows SmartScreen notice:** The installer is not yet code-signed. Windows Defender SmartScreen may show a warning on first run. Click **More info** → **Run anyway**. This is expected for unsigned builds.

Linux builds are planned.

### First Run

On first launch, an onboarding wizard will guide you through setup: choose a language, enter your name, connect a model provider (API key + base URL), and select three models — a **chat model** (main conversation), a **utility model** (lightweight tasks like summarization), and a **utility large model** (memory compilation and deep analysis). Hanako uses the OpenAI-compatible protocol, so any provider that supports it will work (OpenAI, DeepSeek, Qwen, local models via Ollama, etc.).

## Architecture

```
core/           Engine orchestration + Managers (including PluginManager)
lib/            Core libraries (memory, tools, sandbox, bridge adapters)
server/         Hono HTTP + WebSocket server (standalone Node.js process)
hub/            Scheduler, ChannelRouter, EventBus
desktop/        Electron app + React frontend
shared/         Cross-layer utilities (config schema, error bus, model refs)
plugins/        Built-in system plugins (bundled into app)
skills2set/     Built-in skill definitions
scripts/        Build tools (server bundler, launcher, signing)
tests/          Vitest test suite
```

The engine layer coordinates multiple managers (Agent, Session, Model, Preferences, Skill, Channel, BridgeSession, Plugin, etc.) and exposes them through a unified facade. The Hub handles background tasks (heartbeat, cron, channel routing, agent messaging, DM routing) independently of the active chat session.

The server runs as a standalone Node.js process (spawned by Electron or independently), bundled via Vite with @vercel/nft for dependency tracing. It communicates with the Electron renderer through WebSocket.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 38 |
| Frontend | React 19 + Zustand 5 + CSS Modules |
| Build | Vite 7 |
| Server | Hono + @hono/node-server |
| Agent Runtime | [Pi SDK](https://github.com/nicepkg/pi) |
| Database | better-sqlite3 (WAL mode) |
| Testing | Vitest |
| i18n | 5 languages (zh / en / ja / ko / zh-TW) |

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Supported (signed & notarized) |
| macOS (Intel) | Supported |
| Windows | Beta |
| Linux | Planned |
| Mobile (PWA) | Planned |

## Development

```bash
# Install dependencies
npm install

# Start with Electron (builds renderer first)
npm start

# Start with Vite HMR (run npm run dev:renderer first)
npm run start:vite

# Run tests
npm test

# Type check
npm run typecheck
```

## License

[Apache License 2.0](LICENSE)

## Links

- [Homepage](https://openhanako.com)
- [Report an Issue](https://github.com/liliMozi/openhanako/issues)
- [Security](https://github.com/liliMozi/openhanako/security)
- [Security Policy](SECURITY.md)
- [Plugin Development](PLUGINS.md)
- [Contributing](CONTRIBUTING.md)
