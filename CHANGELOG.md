# Changelog

All notable changes to Agentic Researcher are documented here.

## [0.4.0] — unified desktop plugin

Desktop-only unified Agentic Researcher (`package.json` / `manifest.json` 0.4.0). Treat as pre-release until the deterministic mock e2e matrix and live contract gates you care about are green.

### Added
- Editor **Research selection (web)** command and context-menu action: highlight text → side-panel web research → proof-gated streamed/append writeback onto the current note. Optional **Research selection (chat only)** keeps the answer in chat.
- Host final-node verifier (`host-acceptance-v1`) records verification before MissionGraph final completion.
- Continue Latest Run surfaces the ledger/acceptance next action when a run is resumable.

### Changed
- Research-shaped note output treats `research` / `investigate` / cited findings language as content-producing (stream append by default when Chat only is off).
- Evidence conflict detection requires three shared claim terms (fewer false-positive stalls).
- Auto section follow-ups stop once source proof debt is cleared and cap at one section advance per fetch.
- Legacy MissionGraph evidence projection no longer invents vault proof from bare `web_search` / unknown tool-result kinds.
- Bare “latest/current …” language no longer forces web proof debt without an explicit research/web/source cue.

### Known limits
- The automatic Linear queue runs only while Obsidian is open and requires gate 5, a current read-only connection test, complete lifecycle mappings, and an unexpired user-issued grant.
- Automatic Linear `research` ticket execution remains web-read-only and chat-only; automatic vault writes from the queue stay blocked until a trusted vault executor/binding exists.
- GitHub publication (push / draft PR / merge) is available through the Integrations catalog and prepared-action path when configured; treat live provider proof as environment-gated.
- Overnight / long multi-segment runs are not background daemons (Obsidian must stay open for vault work).
- Real-AI soak outcome must be recorded before claiming Product 10 B3.
- Generated-code sandbox execution stays disabled until a Docker/Podman/WSL2/bubblewrap provider passes the boundary probe.

## [0.2.0] — pre-release (historical worktree notes)

Historical notes from the pre-unified worktree.

### Added
- Versioned external-action contracts: `ToolDescriptor`, `PreparedAction`, `AuthorityGrantV1`, and `ActionReceipt`, including fingerprint-bound approval previews, fail-closed registration, readback, reconciliation, and durable action-journal state.
- Fixed Linear GraphQL catalog and explicit tools across capability gates 0-5 for metadata, issues/comments, projects/updates/milestones/cycles, initiatives/updates/documents, labels/relations, and customers/customer requests. No arbitrary GraphQL tool or runtime Linear SDK was added.
- Strict `WorkItemSpecV1` parsing, canonical fingerprinting, human-readable ticket rendering, and machine-block round trips for research, vault, code, and human execution classes.
- Durable Linear queue runtime with a 15-minute/10-candidate scan, updated-since cursor, local leases, verified claim/start lifecycle, two-ticket concurrency, 25-start UTC-day limit, canonical resource locks, grant rechecks, external receipt ledger, and crash reconciliation state.
- Explicit four-hour Linear queue authority with bounded operations/outbound bytes and no delete or GitHub-publication authority.
- Trusted local `RepositoryProfileV1` registry with an extensible Node/npm validation profile, plus a separate host-only GitHub REST scaffold for repository, PR, and checks reads and draft-PR creation.
- Detailed implementation and promotion contract in `docs/plans/linear-first-unified-agent.md`.
- Claim ledger + `claim_grounding` verifier (prompt-gated; ordinary current-market writebacks use URL citation)
- Evidence conflicts, proof debt, research phase controller, research hypotheses
- Durable overnight missions (Obsidian must stay open — not a daemon)
- Mission scheduler, parallel read-only tool batches, source cache
- Failure copy helpers (What / Why / Next) for auth, timeout, policy/approval, WAL, lease/backoff, web fetch/blocked domain, keep-awake, claim/conflict/phase, semantic second-pass
- Day-1 mock e2e scenarios; real-AI soak profile (`docs/plans/real-ai-soak-profile.md`)
- Large-vault soak note (`docs/plans/large-vault-soak.md`; test vault ≥2k notes)

### Changed
- Every default tool now receives an explicit descriptor. Existing vault/code mutations retain their compatibility execution path until they gain side-effect-free preparation; Linear mutations require the new prepare/authorize/execute/readback lifecycle.
- Linear tools are disabled by default and filtered from model definitions unless both the integration is enabled and the prompt contains explicit Linear intent.
- E2E defaults: `npm run test:e2e` → live `gpt-oss:120b-cloud`; `npm run test:e2e:mock` → deterministic mock
- Settings honesty: overnight requires Obsidian open; keep-awake and model router opt-in / experimental
- Router authority mode remains opt-in (never default-on)
