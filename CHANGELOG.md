# Changelog

All notable changes to Agentic Researcher are documented here.

## [0.2.0] — pre-release (worktree)

Treat this worktree as **pre-release** until the B1 Playwright mock gate is green, then bump/tag for release packaging (B8).

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
- Linear tools are disabled by default and filtered from model definitions unless both the integration is enabled and the prompt contains explicit Linear intent. Settings now disclose unencrypted `data.json` key storage and provide a read-only connection test, queue project/lifecycle mappings, and explicit grant controls.
- Run Details approval cards show the prepared destination, target, field-level changes or outbound payload, duplicate candidates, warning text, fingerprint, outbound bytes, and required confirmation step. Canonical external receipts are projected into the receipt surface without allowing them to satisfy vault-write proof.
- E2E defaults: `npm run test:e2e` → live `gpt-oss:120b-cloud`; `npm run test:e2e:mock` → deterministic mock
- Settings honesty: overnight requires Obsidian open; keep-awake and model router opt-in / experimental
- Router authority mode remains opt-in (never default-on)

### Known limits
- The automatic Linear queue runs only while Obsidian is open and requires gate 5, a current read-only connection test, complete lifecycle mappings, and an unexpired user-issued grant.
- Automatic `research` execution is currently web-read-only and chat-only. Automatic vault writes are blocked until a trusted vault executor/binding exists; automatic code execution/promotion is blocked until the trusted repository-profile path passes compatibility e2e proof.
- The GitHub client is scaffolding only. No GitHub token setting, agent tool registration, branch push, publication receipt, PR linkage, review response, or merge operation is enabled.
- Overnight / long multi-segment runs are not background daemons
- Real-AI soak outcome must be recorded before claiming Product 10 B3
- Architecture 10 requires claim/conflict/phase/proof-debt paths proven green end-to-end
