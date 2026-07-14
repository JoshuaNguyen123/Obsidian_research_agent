# Agentic Researcher Companion

The companion is a subordinate, loopback-only process for already-authorized
non-vault work. Obsidian remains the authority for mission planning, approvals,
capability envelopes, and every vault read or mutation.

## Trust boundary

- Every route, including `/health`, `/status`, SSE, and static resources,
  requires `Authorization: Bearer <bootstrap-token>`.
- The server and generated service definitions bind only to `127.0.0.1` (or an
  explicitly selected loopback address). Non-loopback configuration is rejected.
- Browser `Origin` requests are rejected unless an exact origin is configured.
  The service does not emit permissive CORS headers.
- Request bodies are bounded before JSON parsing. OpenAPI and interactive API
  documentation are disabled.
- Companion jobs accept only `companion`, `research`, `code`, `linear`, or
  `github` execution hosts. Vault paths, note content, and vault operations are
  rejected. There is no companion vault API.

## Authentication and secure handoff

Foreground development must set a random token explicitly before starting
Uvicorn:

```powershell
$env:AGENTIC_COMPANION_BOOTSTRAP_TOKEN = '<random 256-bit token>'
python -m uvicorn server:app --host 127.0.0.1 --port 8765 --no-access-log
```

Background installation generates a 256-bit token in the OS credential store.
The service launcher reads it directly from keyring; it is never placed in
argv, a persistent environment variable, a service definition, or plugin data.
The extension obtains it only through a private stdout pipe:

```text
python companion_control.py token --approved-data-root <absolute-app-data-root> --data-dir <absolute-data-dir>
```

The caller must retain that output only inside its authenticated-client closure
and discard the capture buffer after use. The helper prints no token diagnostics.

## Background service commands

These explicit commands install the current user service, inspect it, or remove
it. The canonical `--data-dir` must remain inside the canonical
`--approved-data-root`; both paths are revalidated for links and reparse points
before service writes and process launches. The Node executable must match the
pinned version in `runtime-lock.json`.

```text
python companion_control.py preflight --approved-data-root <absolute-app-data-root> --data-dir <absolute-data-dir> --node-executable <absolute-node> --port 8765
python companion_control.py install   --approved-data-root <absolute-app-data-root> --data-dir <absolute-data-dir> --node-executable <absolute-node> --port 8765
python companion_control.py status    --approved-data-root <absolute-app-data-root> --data-dir <absolute-data-dir> --node-executable <absolute-node> --port 8765
python companion_control.py remove    --approved-data-root <absolute-app-data-root> --data-dir <absolute-data-dir> --node-executable <absolute-node> --port 8765
```

Installation uses a Windows Scheduled Task, macOS LaunchAgent, or Linux systemd
user unit. `remove --remove-bootstrap-token` also deletes the pairing token.
Background work is disabled when keyring does not expose a persistent OS-backed
credential backend. Session-memory secrets remain available only to a foreground
process and disappear on shutdown.

## Durable coordinator API

`coordinator.sqlite3` contains job state, one-owner leases, append-only replay
events, and external receipts. Lease tokens are hashed before persistence.
Creation is idempotent and rejects reuse of a key with different content.

- `POST /jobs`; `GET /jobs` and `GET /jobs/{id}`
- `POST /jobs/{id}/claim`, `/heartbeat`, and `/complete`
- `GET /jobs/{id}/events` (SSE; `after` supports paged replay and a typed
  `replay_boundary` cursor when a bounded response must continue)
- `POST /jobs/{id}/events`
- `GET` and `POST /jobs/{id}/receipts`
- `PUT`-style secret behavior through `POST /secrets`, then
  `GET /secrets/{id}`, `POST /secrets/{id}/lease`, and `DELETE /secrets/{id}`

External work may continue after Obsidian closes only when the original mission
authorization is already present and the secure persistent backend is healthy.
Vault nodes must remain `waiting_obsidian` in the core; the companion cannot
execute them.

## Tests

From the repository root:

```text
python -m pytest companion/tests -q
```
