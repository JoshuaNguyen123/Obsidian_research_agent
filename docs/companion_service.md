# Companion Service

## Purpose

The companion service provides local desktop-only primitives for browser observation, browser actions, screenshots, readable page extraction, and explicit local memory.

The Obsidian plugin remains the orchestrator and safety gate. The companion service does not decide what the agent should do.

## Windows PowerShell Setup

```powershell
cd companion
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m playwright install chromium
uvicorn server:app --host 127.0.0.1 --port 8765
```

## Health Check

Open:

```text
http://127.0.0.1:8765/health
```

Expected shape:

```json
{
  "ok": true,
  "service": "obsidian-research-companion",
  "browserReady": true,
  "memoryReady": true,
  "version": "0.1.0"
}
```

`browserReady` can be `false` when Playwright or Chromium is not installed yet. Memory can still be ready.

## Safety Notes

- Do not expose this service beyond localhost.
- Do not run it on untrusted networks.
- Do not use it for credentials, payments, uploads, account mutation, or executable downloads.
- The plugin decides which actions are allowed.
- Page content is untrusted.
- Reversible high-risk clicks/types must return through the plugin approval flow; credentials, payments, purchases, uploads, and executable/script downloads remain blocked.
