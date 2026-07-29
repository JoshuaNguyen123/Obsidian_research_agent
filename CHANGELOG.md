# Changelog

All notable changes to Agentic Researcher are documented here.

## [0.4.0] — unified desktop plugin

Desktop-only unified Agentic Researcher (`package.json` / `manifest.json` 0.4.0).

**Proof record (2026-07-28):** the exact live BYOK autonomous journey (`npm run test:e2e:byok-autonomous-journey`) is green end to end with its independent verifier: research with 4 host-verified sources → accepted note → Linear issue → validated code in a trusted repository workspace → exact-SHA verified commit `fa32638` → private GitHub draft PR → 69-word human reflection → IDE-openable Desktop export whose own tests pass — with GitHub, vault-backup, and workspace-metadata cleanup independently read back as clean. Model: `deepseek-v4-pro:cloud`. Known limitation: cheaper models (`minimax-m3`, `deepseek-v4-flash`) execute every individual stage but fail the composed journey on quality variance (thin research summaries, unrepairable first-draft code, post-hiccup tool wandering); the lane is model-quality-bound, not product-bound.

### Fixed
- **A mistranscribed Linear issue id can no longer strand an implementation mission.** When the mission names one exact issue and its verified contract read is still unsatisfied, the host substitutes the mission-named identity for a divergent model-echoed `linear_get_issue` id at the execution boundary (`canonicalExactLinearIssueReadIdV1`), with the existing post-read identity verifier unchanged. Previously a fumbled UUID 404-looped the node until the mission blocked.
- **Planner destinations are system-scoped.** The current-note selector fallback ran for every planned step, so all workspace and GitHub nodes in an issue-implementation mission were authored with the initiating note's `.md` path as their exact destination — making `code_workspace_create_file` unsatisfiable the moment the durable-workspace guard could enforce it. The fallback now applies only to vault-system tools; other systems keep `prompt-scoped-<system>-target` or an explicitly named step selector.
- **A completed graph now closes instead of dying on loop accounting.** Two coupled defects: after a resume, the segment-local expected-tool ledger started empty even though the durable graph had proven every node (`missionGraphOnlyFinalSynthesisRemainsV1` now makes the graph authoritative), and the repeated-call budget stop outranked the force-final branch, so a mission with a complete graph and paid delivery died wandering instead of writing its final synthesis. Satisfied required proofs now steer repetition into `force_final_no_tools`.
- **Linear's inline strong-emphasis rewrite no longer blocks idempotent issue adoption.** The provider serializes `__init__` as `**init**`; the reconciliation comparator treated the rewrite as content drift, so a created-then-adopted issue could never reconcile. Both sides now canonicalize inline strong emphasis before diffing, alongside the existing whole-line emphasis rule; genuine token differences still fail closed.
- The BYOK journey harness gained three exactness-preserving fixes of its own: the Phase B run-id read polls instead of racing the durable record; the mutation-authority audit accepts the three real approval-traceability links (identical fingerprints, the `linear-publication-<approvalId>` grant lineage of composite creates, and the content-bound `research-publication:<workItemFingerprint>` idempotency key of replays); and the audit failure message now prints the receipt and every candidate approval so a mismatch is diagnosable from artifacts alone.
- **A provisioned sandbox now actually reaches the plugin.** Host provisioning (`npm run setup:sandbox:wsl2`) records the immutable runtime's non-secret identity in the user environment, but only the settings modal could ever populate `sandbox.providerConfigs`. A fully provisioned machine therefore held zero providers, and every generated-code mission — including a bare "create a CLI checkers game in Python on my desktop" — stopped at `tool-04-code_validate_fast` with "No sandbox provider has passed its boundary probe." The Code runtime now adopts that host-provisioned binding at load, refreshes it when the runtime is re-provisioned under a new digest, and proves its boundary once per session. The probe remains the only authority for execution availability; the environment only nominates a candidate provider.
- Single-stage code delivery is gated at submit on the same sandbox proof as a compound run, so an unavailable sandbox is reported with a one-click next action instead of stranding a half-authored workspace mid-mission.
- Scratch code delivery no longer plans repository-only steps. `code_repair_record_cycle` resolves a trusted repository worktree and fails closed with `trusted_repository_required` anywhere else, so planning it for "write a checkers game on my desktop" put an unsatisfiable node mid-ladder: the workspace and files were authored, then the mission stopped with nothing delivered. Repository missions keep the full repair-and-commit ladder.
- The completion summary names the verified delivery path. A run that exported a real game to the Desktop used to end with "Done. 6 write operations completed." — the user was never told where it landed.
- Delivered folders are named after the request. Only the number-guessing e2e prompt had a real label; everything else landed on the Desktop as `code-deliverable-<hex>`. A checkers request now delivers `cli-checkers-game-<run>`, and the label is sanitized to a bounded `[a-z0-9-]` path segment.
- The delivery announcement names the artifact for every request, not just the one hardcoded prompt ("## Done — Code delivered" for everything else).
- A blocked run states the blocker in chat. It used to say "Blocked — open Run Details for the blocker" and save that uninformative line into conversation history, so the reason was lost from the transcript.
- **Orchestrator coding missions no longer leak a temp directory per run.** `GitWorktreeManager` lazily created one `agentic-researcher-disabled-hooks-*` directory under the OS temp root to neutralize git hooks and never removed it; 1,559 had accumulated on the development host. It now has an idempotent, best-effort `dispose()` that only ever removes a directly-owned directory carrying that exact prefix, called from the mission's `finally`. The unit suite was the dominant producer — it created managers without disposing them and leaked three per `npm test` run — so `tests/gitWorktreeManager.test.ts` now disposes every manager it creates.
- `npm run cleanup:e2e-runtime-residue` replaces the old daily-use cleanup, which matched a single `du03-live-*` prefix and therefore left every other lane's residue behind. It is a dry run by default, covers workspace metadata, repository worktrees, and temp directories, and reports anything ambiguous instead of deleting it.
- "save …" and "generate …" now count as code-deliverable phrasings, and `generate`/`make`/`build` count as known-folder export phrasings. "save a tic tac toe game in Python to my Documents folder" previously routed to no code tools at all, and "generate a python snake game on my desktop" planned the whole authoring ladder but no export.

- **Published Linear issues are assigned to you.** Discovery already recorded the connected viewer in `linearCapabilitySnapshot.viewer`, but `ResearchTicketPublisher.publish()` built its `linear_create_issue` payload with team, project, title, and description and no assignee — so every issue the agent filed landed unowned. It now defaults to the discovered viewer, keeps an explicit assignee authoritative, fails open to unassigned if resolution throws, and can be turned off with `linearAssignPublishedIssuesToViewer`.
- **A fine-grained GitHub PAT no longer blocks cleanup missions.** `githubCleanupAuthorityFromScopesV1` inferred delete authority from scope strings, but GitHub only returns `X-OAuth-Scopes` for classic tokens; a fine-grained PAT correctly reports none, which the gate read as "not authorized" and used to fail closed on every cleanup-stage mission. Authority is now reported as unknown for that credential kind and settled by the actual attempt, while an observable classic token that genuinely lacks `delete_repo` still fails closed.
- **The e2e harness can no longer report a skipped lane as a pass.** `run-e2e-exclusive.mjs` now reads a Playwright JSON report and fails when any selected project executed no non-skipped test — the exact shape that let `test:e2e:journeys` report success while its comma-joined `E2E_PLAYWRIGHT_LANE` made exact-equality guards skip themselves. That script is deleted, lane guards share a tolerant `laneSelectedV1`, and specs matched by two projects carry guards so they cannot run twice.
- **A passing run now leaves machine-readable proof.** `dailyUseReporter` only recorded `DU-0X`-titled tests, `daily-use` projects, and failures, so the flagship lane wrote no `daily-use-run-summary.json` at all — which also made the `ci.yml` job wired to `--lanes=desktop` fail on a passing run. The scorecard gate no longer returns a silent skip for lanes absent from the baseline; missing baselines are proof debt, with an explicit exemption set for lanes that make no model calls.
- `compound-flow-real-live` no longer falls back to a hard-coded Linear team UUID; it requires `LINEAR_LIVE_TEST_TEAM_ID` and asserts the id belongs to the connected workspace before mutating anything.

### Removed
- **The deterministic mock-model Playwright matrix.** Those lanes injected the sandbox provider configuration the product never adopted, so they stayed green on a host where a basic request could not complete — precisely the failure they existed to catch. Every remaining lane drives the installed plugin inside real Obsidian against a real model, a real external service, or both; `--mock-ai` is now refused with an explicit error. A new `desktop-checkers-delivery-real-live` lane replays the exact reported prompt from the exact reported state (zero configured providers), then compiles and runs the delivered game.

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
- Generated-code sandbox execution stays disabled until a Docker/Podman/WSL2/bubblewrap provider passes the boundary probe. Adoption of a host-provisioned binding removes the manual configuration step, not the probe.

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
