import { createHash } from "node:crypto";

import {
  parseRepositoryProfileV2,
  repositoryProfileExecutionBlockersV2,
  type RepositoryProfileV2,
  type RepositoryValidationCommandV2,
} from "../repositories/RepositoryProfileV2";

export type SandboxProviderKindV2 = "docker" | "podman" | "wsl2" | "bubblewrap";
export type SandboxActionPurposeV2 =
  | "validation_fast"
  | "validation_targeted"
  | "validation_full"
  | "code_block"
  | "lockfile_restore";

export interface SandboxProviderConfigV2 {
  version: 1;
  kind: SandboxProviderKindV2;
  executable: string;
  priority: number;
  runtimeReference: string;
  runtimeDigest: string;
  wslDistribution: string | null;
  runtimeRoot: string | null;
}

export interface SandboxHostCommandSpecV2 {
  version: 1;
  provider: SandboxProviderKindV2;
  purpose: "boundary_probe" | "execute";
  executable: string;
  args: string[];
  shell: false;
  cwd: null;
  env: Record<string, string>;
  timeoutMs: number;
  stdinMode: "none" | "verified_staging_bundle";
  stdoutMode: "boundary_probe_json" | "artifact_bundle";
}

export interface SandboxRunnerResultV2 {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts?: Readonly<Record<string, Uint8Array>>;
}

export interface SandboxCommandRunnerV2 {
  run(
    spec: SandboxHostCommandSpecV2,
    input?: {
      stagedFiles?: readonly SandboxStagedFileBytesV2[];
      signal?: AbortSignal;
    },
  ): Promise<SandboxRunnerResultV2>;
}

export interface SandboxProviderStatusV2 {
  provider: SandboxProviderKindV2;
  /**
   * - `unprobed`   — the probe has not run.
   * - `verified`   — the probe answered and proved every isolation property.
   * - `rejected`   — A VERDICT OF FAIL. The probe answered and the boundary did
   *                  not hold. Terminal; never retried, never softened.
   * - `unavailable`— the provider could not run the probe at all (non-zero exit
   *                  or a failed spawn). A host condition, not a verdict.
   * - `no_verdict` — the probe was killed before answering (timeout or caller
   *                  abort). Nothing was proven either way.
   *
   * Only `verified` ever enables execution; every gate in this module and its
   * consumers tests positively for `verified`, so a new state can never widen
   * what is allowed to run.
   */
  state: "unprobed" | "verified" | "unavailable" | "rejected" | "no_verdict";
  diagnostic: string;
  probeFingerprint: string | null;
  checkedAt: string | null;
}

export interface SandboxCapabilityStatusV2 {
  version: 1;
  mode: "editing_only" | "sandbox_verified";
  executionAvailable: boolean;
  editingAvailable: true;
  selectedProvider: SandboxProviderKindV2 | null;
  providers: SandboxProviderStatusV2[];
  blocker: SandboxDurableBlockerV2 | null;
}

export interface SandboxDurableBlockerV2 {
  version: 1;
  code:
    | "sandbox_provider_unavailable"
    | "sandbox_boundary_probe_failed"
    | "sandbox_authorization_required"
    | "sandbox_runtime_digest_required"
    | "sandbox_staging_mismatch"
    | "sandbox_staging_transport_unsupported"
    | "sandbox_execution_failed"
    | "sandbox_artifact_readback_failed";
  message: string;
  requiredAction: string;
  retryable: boolean;
  editingAvailable: true;
  executionAvailable: false;
  fingerprint: string;
}

export interface SandboxStagingEntryV2 {
  path: string;
  sha256: string;
  bytes: number;
}

export interface SandboxExpectedArtifactV2 {
  path: string;
  expectedSha256: string | null;
  maxBytes: number;
  required: boolean;
}

export interface SandboxStagedFileBytesV2 {
  path: string;
  bytes: Uint8Array;
}

export interface PreparedSandboxActionV2 {
  version: 1;
  id: string;
  purpose: SandboxActionPurposeV2;
  provider: SandboxProviderKindV2;
  profileKey: string;
  projectId: string;
  commandId: string;
  workspaceId: string;
  /** Exact repair request binding for validation actions; null otherwise. */
  repairRequestId: string | null;
  workspaceManifestFingerprint: string;
  runtimeDigest: string;
  probeFingerprint: string;
  command: {
    executable: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  };
  network: {
    mode: "disabled" | "exact_approval_required";
    credentialPolicy: "none";
  };
  resources: {
    cpuCount: number;
    memoryMb: number;
    pidLimit: number;
    timeoutMs: number;
  };
  environment: Record<string, string>;
  stagingManifest: SandboxStagingEntryV2[];
  expectedArtifacts: SandboxExpectedArtifactV2[];
  preparedAt: string;
  expiresAt: string;
  payloadFingerprint: string;
}

export interface SandboxPrepareInputV2 {
  profile: RepositoryProfileV2;
  purpose: SandboxActionPurposeV2;
  projectId: string;
  commandId: string;
  workspaceId: string;
  repairRequestId: string | null;
  workspaceManifestFingerprint: string;
  stagingManifest: readonly SandboxStagingEntryV2[];
  expectedArtifacts?: readonly SandboxExpectedArtifactV2[];
  environment?: Readonly<Record<string, string>>;
  resources?: Partial<PreparedSandboxActionV2["resources"]>;
  ttlMs?: number;
}

export interface SandboxAuthorizationV2 {
  preparedActionId: string;
  payloadFingerprint: string;
  grantId: string;
}

export interface SandboxImportedArtifactV2 {
  path: string;
  sha256: string;
  bytes: number;
  readbackSha256: string;
}

export interface SandboxExecutionReceiptV2 {
  version: 1;
  id: string;
  actionId: string;
  provider: SandboxProviderKindV2;
  profileKey: string;
  projectId: string;
  commandId: string;
  purpose: SandboxActionPurposeV2;
  status: "verified" | "failed";
  exitCode: number;
  commandFingerprint: string;
  stagingManifestFingerprint: string;
  boundaryProbeFingerprint: string;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutBytes: number;
  stderrBytes: number;
  importedArtifacts: SandboxImportedArtifactV2[];
  authorizationGrantId: string;
  startedAt: string;
  completedAt: string;
  fingerprint: string;
}

export interface SandboxValidationDiagnosticsV1 {
  version: 1;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  redactedLines: number;
}

/**
 * Foreground-only, redacted validation output for the active model repair turn.
 * This value is deliberately separate from the durable validation receipt and
 * must never be written to the receipt registry or conversation history.
 */
export interface SandboxTransientDiagnosticExcerptV1 {
  version: 1;
  stdout: string;
  stderr: string;
  truncated: boolean;
  redactedLines: number;
}

export type SandboxPreparationResultV2 =
  | { status: "prepared"; action: PreparedSandboxActionV2 }
  | { status: "blocked"; blocker: SandboxDurableBlockerV2 };

export type SandboxExecutionResultV2 =
  | {
      status: "verified" | "failed";
      receipt: SandboxExecutionReceiptV2;
      /** Receipt-bound metadata safe for durable loop detection. */
      diagnostics: SandboxValidationDiagnosticsV1;
      /** Redacted and bounded foreground repair context; never persisted. */
      diagnosticExcerpt: SandboxTransientDiagnosticExcerptV1;
    }
  | { status: "blocked"; blocker: SandboxDurableBlockerV2 };

export interface SandboxArtifactImporterV2 {
  importArtifacts(input: ReadonlyArray<{
    path: string;
    bytes: Uint8Array;
    sha256: string;
  }>): Promise<ReadonlyArray<{
    path: string;
    readbackSha256: string;
  }>>;
}

export interface SandboxManagerOptionsV2 {
  runner: SandboxCommandRunnerV2;
  providers: readonly SandboxProviderConfigV2[];
  now?: () => Date;
}

/**
 * Environment keys a sandbox command may receive. Exported so the host-owned
 * validation path can drop a model's other hints before they reach
 * `prepareExecution`, where an unknown key is a rejection; the manager keeps
 * enforcing this list for every caller.
 */
export const SANDBOX_ENVIRONMENT_ALLOWLIST_V2: ReadonlySet<string> = new Set([
  "CI",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "SOURCE_DATE_EPOCH",
  "TZ",
]);
const MAX_STAGED_FILES = 100;
const MAX_STAGED_FILE_BYTES = 2_000_000;
const MAX_STAGED_TOTAL_BYTES = 10_000_000;
const MAX_ARTIFACT_BYTES = 10_000_000;
const PROBE_TIMEOUT_MS = 30_000;
// A dedicated WSL distribution may need to cold-start before bwrap can run the
// fixed boundary command. Keep the ordinary provider budget tight, but allow
// WSL2 enough time to produce fresh attestation under normal workstation load.
export const WSL2_SANDBOX_PROBE_TIMEOUT_MS_V2 = 90_000;

/**
 * Bounded recovery for a boundary probe that produced NO VERDICT.
 *
 * A probe answers exactly one question: "is this provider actually confining
 * code?" There are two failure shapes and they are not interchangeable.
 *
 *   - A VERDICT OF FAIL. The probe ran and answered, and the answer did not
 *     prove isolation (unparseable proof, a false isolation property, a runtime
 *     digest that is not ours, oversized output). This is `state: "rejected"`.
 *     It is a security result and it is FINAL: re-running a provider that just
 *     told us the boundary does not hold could only ever launder a "no" into a
 *     "yes", so `rejected` is returned immediately and is never re-attempted.
 *
 *   - NO VERDICT. The provider process was killed before it could answer, so
 *     nothing was learned either way. This is `state: "no_verdict"`, and it is
 *     retriable for exactly the same reason a TCP connection that never
 *     returned is retriable: no evidence was produced to soften.
 *
 * Retrying is admissible here only because the boundary probe command is fixed
 * (built from provider configuration alone, `stdinMode: "none"`, never carrying
 * a prepared action or staged repository bytes), so a second attempt has no
 * workspace side effect and cannot execute repository code.
 *
 * ATTEMPTS: 2 (one retry). Host saturation — the measured cause — has a time
 * constant of minutes, so a third attempt inside the same contention window is
 * almost perfectly correlated with the second and buys nearly no new
 * information, while every extra attempt costs a full provider budget in serial
 * across up to four providers. Two attempts keep the worst case within one
 * order of the original budget and keep the attestation window tight.
 */
export const SANDBOX_PROBE_NO_VERDICT_ATTEMPTS_V2 = 2;

/**
 * Load-aware escalation, measured rather than guessed.
 *
 * The first attempt always runs at the ordinary budget, so a quiet host still
 * fails fast and nothing about a real rejection gets slower. A timeout on that
 * first attempt IS the load measurement: it is direct evidence this host could
 * not complete a fixed probe within the normal budget. Only then do we spend
 * more, and only once.
 *
 * We deliberately do NOT read `os.loadavg()`: it returns [0,0,0] on Windows,
 * which is precisely the host that runs the WSL2 provider, and the portable
 * alternative — a synthetic busy-loop benchmark — would burn CPU on an already
 * saturated machine to produce an arbitrarily calibrated number.
 *
 * BOUNDS: the escalated budget is `base * 2`, hard-capped by the ceiling below.
 * Worst-case wall clock per provider is therefore `base + min(base * 2, ceiling)`
 * — 90s + 180s for WSL2, 30s + 60s for every other provider — and a probe that
 * will never answer still fails closed inside that stated bound.
 */
export const SANDBOX_PROBE_ESCALATED_TIMEOUT_FACTOR_V2 = 2;
export const SANDBOX_PROBE_TIMEOUT_CEILING_MS_V2 = 180_000;

/**
 * Greppable operator markers. These two strings are the difference between "the
 * sandbox told us it is not safe" and "the sandbox never answered", and they
 * must stay stable: harness classification greps them to separate an
 * infrastructure outage from a real boundary defect.
 */
export const SANDBOX_PROBE_NO_VERDICT_MARKER_V2 = "sandbox_probe_no_verdict";
export const SANDBOX_PROBE_BOUNDARY_VIOLATION_MARKER_V2 = "sandbox_probe_boundary_violation";

/**
 * Sandbox-only execution boundary. A runner must be injected explicitly; this
 * module has no child_process import, native execution path, or fallback.
 */
export class SandboxManagerV2 {
  private readonly runner: SandboxCommandRunnerV2;
  private readonly providers: SandboxProviderConfigV2[];
  private readonly now: () => Date;
  private statuses: SandboxProviderStatusV2[];

  constructor(options: SandboxManagerOptionsV2) {
    if (!options.runner || typeof options.runner.run !== "function") {
      throw new SandboxManagerV2Error("SandboxManagerV2 requires an explicit command runner.");
    }
    this.runner = options.runner;
    this.providers = options.providers.map(parseSandboxProviderConfigV2).sort(
      (left, right) => left.priority - right.priority,
    );
    if (new Set(this.providers.map((provider) => provider.kind)).size !== this.providers.length) {
      throw new SandboxManagerV2Error("Sandbox provider kinds must be unique.");
    }
    this.now = options.now ?? (() => new Date());
    this.statuses = this.providers.map((provider) => ({
      provider: provider.kind,
      state: "unprobed",
      diagnostic: "Boundary probe has not run.",
      probeFingerprint: null,
      checkedAt: null,
    }));
  }

  /**
   * A non-null blocker for "no usable provider." Both the no-provider-selected
   * path and the named-provider-not-configured path route through here, so the
   * fail-closed result always carries a blocker consumers can read — a prepared
   * action naming an unconfigured provider while another is verified must not
   * yield { status: "blocked", blocker: null } and crash on blocker.code.
   */
  private providerUnavailableBlocker(kind?: SandboxProviderKindV2): SandboxDurableBlockerV2 {
    const providerDiagnostic = summarizeUnavailableProviders(this.statuses);
    const namePart = kind
      ? `The prepared action names provider "${kind}", which is not configured on this host. `
      : "";
    return blocker(
      "sandbox_provider_unavailable",
      `${namePart}${
        providerDiagnostic
          ? `No sandbox provider has passed its boundary probe. ${providerDiagnostic}`
          : "No sandbox provider has passed its boundary probe."
      }`,
      "Install or repair Docker, Podman, the dedicated WSL2 sandbox, or bubblewrap, then run the explicit boundary probe.",
      true,
    );
  }

  /** Read cached health without starting a process or mutating provider state. */
  readStatus(): SandboxCapabilityStatusV2 {
    const selected = this.selectedProvider();
    const statusBlocker = selected ? null : this.providerUnavailableBlocker();
    return {
      version: 1,
      mode: selected ? "sandbox_verified" : "editing_only",
      executionAvailable: Boolean(selected),
      editingAvailable: true,
      selectedProvider: selected?.kind ?? null,
      providers: this.statuses.map((status) => ({ ...status })),
      blocker: statusBlocker,
    };
  }

  /** Explicitly probe fixed provider boundaries; never execute repository code. */
  async probeProviders(signal?: AbortSignal): Promise<SandboxCapabilityStatusV2> {
    const next: SandboxProviderStatusV2[] = [];
    for (const provider of this.providers) {
      next.push(await this.probeOne(provider, signal));
    }
    this.statuses = next;
    return this.readStatus();
  }

  async prepareExecution(input: SandboxPrepareInputV2): Promise<SandboxPreparationResultV2> {
    const selected = this.selectedProvider();
    if (!selected) return { status: "blocked", blocker: this.providerUnavailableBlocker() };
    const profile = parseRepositoryProfileV2(input.profile);
    const runtimeBlockers = repositoryProfileExecutionBlockersV2(profile);
    if (runtimeBlockers.length > 0) {
      return {
        status: "blocked",
        blocker: blocker(
          "sandbox_runtime_digest_required",
          `Repository runtime identity is unresolved: ${runtimeBlockers.join(", ")}.`,
          "Confirm the immutable runtime digest once or add a repository-pinned runtime file/wrapper.",
          true,
        ),
      };
    }
    const project = profile.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) throw new SandboxManagerV2Error("Sandbox action references an unknown project.");
    const command = profile.validationCatalog.find(
      (candidate) => candidate.id === input.commandId && candidate.projectId === project.id,
    );
    if (!command) throw new SandboxManagerV2Error("Sandbox action references an unknown validation command.");
    assertPurposeMatchesCommand(input.purpose, command);
    const runtime = profile.pinnedRuntimes.find((candidate) =>
      candidate.projectId === project.id &&
      project.ecosystems.includes(candidate.ecosystem) &&
      candidate.executable === command.executable,
    ) ?? profile.pinnedRuntimes.find(
      (candidate) =>
        candidate.projectId === project.id &&
        project.ecosystems.includes(candidate.ecosystem),
    );
    if (!runtime?.digest) {
      return {
        status: "blocked",
        blocker: blocker(
          "sandbox_runtime_digest_required",
          "The selected command does not have a verified immutable runtime digest.",
          "Confirm the exact runtime digest before preparing execution.",
          true,
        ),
      };
    }
    const stagingManifest = parseStagingManifest(input.stagingManifest);
    const expectedArtifacts = parseExpectedArtifacts(
      input.expectedArtifacts ?? [],
      profile.generatedOutputs,
    );
    const environment = parseEnvironment(input.environment ?? {});
    const resources = parseResources(input.resources ?? {}, command.timeoutMs);
    const repairRequestId = input.repairRequestId === null
      ? null
      : stableId(input.repairRequestId, "repair request id");
    const validationPurpose = input.purpose === "validation_fast" ||
      input.purpose === "validation_targeted" ||
      input.purpose === "validation_full";
    if (validationPurpose !== (repairRequestId !== null)) {
      throw new SandboxManagerV2Error(
        validationPurpose
          ? "Validation sandbox actions require an exact repair request id."
          : "Non-validation sandbox actions cannot carry repair request authority.",
      );
    }
    const now = this.now();
    const ttlMs = boundedInteger(input.ttlMs ?? 300_000, "sandbox action TTL", 10_000, 900_000);
    const preparedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const status = this.statuses.find((candidate) => candidate.provider === selected.kind)!;
    const core = {
      version: 1 as const,
      purpose: input.purpose,
      provider: selected.kind,
      profileKey: profile.key,
      projectId: project.id,
      commandId: command.id,
      workspaceId: stableId(input.workspaceId, "workspace id"),
      repairRequestId,
      workspaceManifestFingerprint: fingerprint(
        input.workspaceManifestFingerprint,
        "workspace manifest fingerprint",
      ),
      // The repository runtime record proves the declared ecosystem/pin has
      // been resolved. Command execution is bound to the separately attested
      // immutable sandbox bundle, whose manifest independently permits the
      // exact executable. A repository pin hash is not a runtime image hash.
      runtimeDigest: selected.runtimeDigest,
      probeFingerprint: status.probeFingerprint!,
      command: {
        executable: command.executable,
        args: [...command.args],
        cwd: command.cwd,
        timeoutMs: command.timeoutMs,
      },
      network: {
        mode: command.network,
        credentialPolicy: "none" as const,
      },
      resources,
      environment,
      stagingManifest,
      expectedArtifacts,
      preparedAt,
      expiresAt,
    };
    const payloadFingerprint = sha256Canonical(core);
    const id = `sandbox-action-${payloadFingerprint.slice("sha256:".length, "sha256:".length + 32)}`;
    return {
      status: "prepared",
      action: { ...core, id, payloadFingerprint },
    };
  }

  async executePrepared(
    rawAction: PreparedSandboxActionV2,
    input: {
      authorization: SandboxAuthorizationV2 | null;
      stagedFiles: readonly SandboxStagedFileBytesV2[];
      artifactImporter?: SandboxArtifactImporterV2;
      signal?: AbortSignal;
    },
  ): Promise<SandboxExecutionResultV2> {
    const action = parsePreparedSandboxActionV2(rawAction);
    const now = this.now();
    if (Date.parse(action.expiresAt) <= now.getTime()) {
      return {
        status: "blocked",
        blocker: blocker(
          "sandbox_authorization_required",
          "The prepared sandbox action expired.",
          "Prepare the action again and obtain fresh authorization.",
          true,
        ),
      };
    }
    if (
      !input.authorization ||
      input.authorization.preparedActionId !== action.id ||
      input.authorization.payloadFingerprint !== action.payloadFingerprint ||
      !input.authorization.grantId.trim()
    ) {
      return {
        status: "blocked",
        blocker: blocker(
          "sandbox_authorization_required",
          "Sandbox execution requires authorization bound to this exact prepared payload.",
          action.network.mode === "exact_approval_required"
            ? "Approve the exact lockfile restoration preview; the approval is invalidated by any payload drift."
            : "Authorize the exact prepared sandbox action.",
          true,
        ),
      };
    }
    let stagedFiles: SandboxStagedFileBytesV2[];
    try {
      stagedFiles = verifyStagedFiles(action.stagingManifest, input.stagedFiles);
    } catch (error) {
      return {
        status: "blocked",
        blocker: blocker(
          "sandbox_staging_mismatch",
          `Workspace staging did not match the declared manifest. ${WITHHELD_BLOCKER_DETAIL_V2}`,
          "Restage the workspace from the declared manifest and retry with fresh hashes.",
          true,
        ),
      };
    }
    const provider = this.providers.find((candidate) => candidate.kind === action.provider);
    if (!provider) return { status: "blocked", blocker: this.providerUnavailableBlocker(action.provider) };
    const freshProbe = await this.probeOne(provider, input.signal);
    this.statuses = this.statuses.map((status) =>
      status.provider === provider.kind ? freshProbe : status,
    );
    if (freshProbe.state !== "verified" || freshProbe.probeFingerprint !== action.probeFingerprint) {
      return {
        status: "blocked",
        blocker: blocker(
          "sandbox_boundary_probe_failed",
          "The sandbox boundary changed after preparation.",
          "Repair and re-probe the provider, then prepare a new action.",
          true,
        ),
      };
    }
    const spec = buildSandboxExecutionCommandV2(provider, action);
    const startedAt = this.now().toISOString();
    let execution: SandboxRunnerResultV2;
    try {
      execution = await this.runner.run(spec, { stagedFiles, signal: input.signal });
    } catch (error) {
      return { status: "blocked", blocker: sandboxExecutionFailedBlockerV2(error) };
    }
    assertBoundedRunnerResult(execution);
    const imported: SandboxImportedArtifactV2[] = [];
    try {
      const pendingImports: Array<{ path: string; bytes: Uint8Array; sha256: string }> = [];
      for (const expected of action.expectedArtifacts) {
        const bytes = execution.artifacts?.[expected.path];
        if (!bytes) {
          if (expected.required) throw new SandboxManagerV2Error(`Required sandbox artifact is missing: ${expected.path}.`);
          continue;
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > expected.maxBytes) {
          throw new SandboxManagerV2Error(`Sandbox artifact exceeds its declared bound: ${expected.path}.`);
        }
        const sha256 = sha256Bytes(bytes);
        if (expected.expectedSha256 && expected.expectedSha256 !== sha256) {
          throw new SandboxManagerV2Error(`Sandbox artifact hash changed: ${expected.path}.`);
        }
        if (!input.artifactImporter) {
          throw new SandboxManagerV2Error("Selective artifact import requires an explicit readback importer.");
        }
        pendingImports.push({
          path: expected.path,
          bytes,
          sha256,
        });
      }
      if (pendingImports.length > 0) {
        const readbacks = await input.artifactImporter!.importArtifacts(pendingImports);
        const readbackByPath = new Map(readbacks.map((readback) => [readback.path, readback.readbackSha256]));
        if (readbacks.length !== pendingImports.length || readbackByPath.size !== pendingImports.length) {
          throw new SandboxManagerV2Error("Atomic artifact importer returned an incomplete or duplicate readback set.");
        }
        for (const artifact of pendingImports) {
          const readbackSha256 = readbackByPath.get(artifact.path);
          if (readbackSha256 !== artifact.sha256) {
            throw new SandboxManagerV2Error(`Imported artifact readback failed: ${artifact.path}.`);
          }
          imported.push({
            path: artifact.path,
            sha256: artifact.sha256,
            bytes: artifact.bytes.byteLength,
            readbackSha256,
          });
        }
      }
    } catch (error) {
      return {
        status: "blocked",
        blocker: blocker(
          "sandbox_artifact_readback_failed",
          `Imported artifacts failed durable readback. ${WITHHELD_BLOCKER_DETAIL_V2}`,
          "Discard imported artifacts, restage from the verified workspace, and rerun validation.",
          true,
        ),
      };
    }
    const receiptCore = {
      version: 1 as const,
      id: `sandbox-receipt-${action.payloadFingerprint.slice("sha256:".length, "sha256:".length + 24)}`,
      actionId: action.id,
      provider: action.provider,
      profileKey: action.profileKey,
      projectId: action.projectId,
      commandId: action.commandId,
      purpose: action.purpose,
      status: execution.exitCode === 0 ? "verified" as const : "failed" as const,
      exitCode: execution.exitCode,
      commandFingerprint: sha256Canonical(action.command),
      stagingManifestFingerprint: sha256Canonical(action.stagingManifest),
      boundaryProbeFingerprint: action.probeFingerprint,
      stdoutSha256: sha256Text(execution.stdout),
      stderrSha256: sha256Text(execution.stderr),
      stdoutBytes: Buffer.byteLength(execution.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(execution.stderr, "utf8"),
      importedArtifacts: imported.sort((left, right) => compareCanonicalText(left.path, right.path)),
      authorizationGrantId: input.authorization.grantId,
      startedAt,
      completedAt: this.now().toISOString(),
    };
    const receipt = { ...receiptCore, fingerprint: sha256Canonical(receiptCore) };
    return {
      status: receipt.status,
      receipt,
      diagnostics: transientDiagnostics(execution.stdout, execution.stderr),
      diagnosticExcerpt: transientDiagnosticExcerpt(execution.stdout, execution.stderr),
    };
  }

  private selectedProvider(): SandboxProviderConfigV2 | null {
    for (const provider of this.providers) {
      if (this.statuses.find((status) => status.provider === provider.kind)?.state === "verified") {
        return provider;
      }
    }
    return null;
  }

  private async probeOne(
    provider: SandboxProviderConfigV2,
    signal?: AbortSignal,
  ): Promise<SandboxProviderStatusV2> {
    // The fingerprinted spec is ALWAYS the canonical base spec, never the
    // escalated copy handed to the runner on a retry. prepareExecution() records
    // a probe fingerprint and executePrepared() re-probes and demands exact
    // equality, so a probe that needed a retry has to fingerprint identically to
    // one that passed first try. Folding the escalated timeout — or the attempt
    // count — into the fingerprint would block every prepared action whose
    // re-probe took a different number of attempts.
    const spec = buildSandboxProbeCommandV2(provider);
    let lastNoVerdict: { diagnostic: string; timeoutMs: number } | null = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= SANDBOX_PROBE_NO_VERDICT_ATTEMPTS_V2; attempt += 1) {
      const checkedAt = this.now().toISOString();
      const timeoutMs = attempt === 1
        ? spec.timeoutMs
        : escalatedProbeTimeoutMsV2(spec.timeoutMs);
      attempts = attempt;
      try {
        const result = await this.runner.run(
          attempt === 1 ? spec : { ...spec, timeoutMs },
          { signal },
        );
        if (result.exitCode !== 0) {
          // The provider answered with a failure exit. That is a host condition,
          // not a boundary verdict, and it is deterministic — not retried.
          const providerDiagnostic = safeDiagnostic(result.stderr).trim();
          return {
            provider: provider.kind,
            state: "unavailable",
            diagnostic: [
              `Probe exited ${result.exitCode}.`,
              providerDiagnostic,
            ].filter(Boolean).join(" "),
            probeFingerprint: null,
            checkedAt,
          };
        }
        const proof = parseBoundaryProof(result.stdout, provider.runtimeDigest);
        const probeFingerprint = sha256Canonical({ version: 1, provider, spec, proof });
        return {
          provider: provider.kind,
          state: "verified",
          // A pass that needed a retry must never read like a clean first-try
          // pass; the recovery is stated in the status an operator reads.
          diagnostic: lastNoVerdict
            ? `Boundary probe verified on attempt ${attempt} of ${SANDBOX_PROBE_NO_VERDICT_ATTEMPTS_V2} ` +
              `after ${SANDBOX_PROBE_NO_VERDICT_MARKER_V2} at ${lastNoVerdict.timeoutMs}ms: ` +
              `${lastNoVerdict.diagnostic} Retried at ${timeoutMs}ms.`
            : "Boundary probe verified.",
          probeFingerprint,
          checkedAt,
        };
      } catch (error) {
        const failure = classifyProbeFailureV2(error);
        if (failure === "verdict") {
          // A VERDICT OF FAIL: the probe answered and the boundary did not hold.
          // Return on the spot. No retry, no escalation, no softening.
          return {
            provider: provider.kind,
            state: "rejected",
            diagnostic: `${SANDBOX_PROBE_BOUNDARY_VIOLATION_MARKER_V2}: ${safeDiagnostic(error)}`,
            probeFingerprint: null,
            checkedAt,
          };
        }
        if (failure === "unavailable") {
          return {
            provider: provider.kind,
            state: "unavailable",
            diagnostic: safeDiagnostic(error),
            probeFingerprint: null,
            checkedAt,
          };
        }
        lastNoVerdict = { diagnostic: safeDiagnostic(error), timeoutMs };
        // Only a timeout earns another attempt. A caller-driven abort produced no
        // verdict either, but retrying it would ignore the cancellation.
        if (!isRetriableNoVerdictProbeFailureV2(error) || signal?.aborted) break;
      }
    }

    // Fail closed and stay loud: no verdict was ever produced, so no provider is
    // selectable and execution stays blocked.
    return {
      provider: provider.kind,
      state: "no_verdict",
      diagnostic:
        `${SANDBOX_PROBE_NO_VERDICT_MARKER_V2}: ${lastNoVerdict?.diagnostic ?? "Boundary probe produced no verdict."} ` +
        `The boundary was neither proven nor disproven after ${attempts} ` +
        `attempt${attempts === 1 ? "" : "s"} (last budget ${lastNoVerdict?.timeoutMs ?? spec.timeoutMs}ms).`,
      probeFingerprint: null,
      checkedAt: this.now().toISOString(),
    };
  }
}

/**
 * Bounded escalation for the single retry. Never exceeds the stated ceiling, and
 * never shortens a budget that is already above it.
 */
function escalatedProbeTimeoutMsV2(baseTimeoutMs: number): number {
  return Math.max(
    baseTimeoutMs,
    Math.min(baseTimeoutMs * SANDBOX_PROBE_ESCALATED_TIMEOUT_FACTOR_V2, SANDBOX_PROBE_TIMEOUT_CEILING_MS_V2),
  );
}

/**
 * Structural read of a runner error code. The manager deliberately does not
 * import the spawn runner — it must stay usable with any injected runner — so
 * the contract is duck-typed on the documented `code` field.
 */
export function sandboxRunnerErrorCodeV2(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * The single place that decides what a thrown probe failure MEANS. Default is
 * `"verdict"`: anything this function does not positively recognise as a host
 * condition is treated as a boundary answer we must respect, so an unfamiliar
 * error can only ever fail closed and terminally — never become retriable.
 */
function classifyProbeFailureV2(error: unknown): "verdict" | "unavailable" | "no_verdict" {
  switch (sandboxRunnerErrorCodeV2(error)) {
    // Killed before it could answer. Nothing proven either way.
    case "provider_timeout":
    case "provider_aborted":
      return "no_verdict";
    // The provider binary never started, or exited with its own failure
    // signature (a code above 255) on every launch of the ladder; it cannot
    // have judged anything.
    case "provider_spawn_failed":
    case "provider_exit_signature":
      return "unavailable";
    default:
      return "verdict";
  }
}

/**
 * The blocker for a runner that threw before a validated result. Its text is
 * fixed (a caught exception's message can carry host paths or command lines)
 * except for one number: a provider exit signature is a 32-bit code from the
 * provider binary itself, never command output, and it is what tells a WSL
 * launch failure apart from everything else in retained telemetry.
 */
export function sandboxExecutionFailedBlockerV2(error: unknown): SandboxDurableBlockerV2 {
  const code = sandboxRunnerErrorCodeV2(error);
  if (code === "unsupported_staging") {
    return blocker(
      "sandbox_staging_transport_unsupported",
      `Sandbox provider failed before a validated result. ${WITHHELD_BLOCKER_DETAIL_V2}`,
      "Install a sandbox runtime implementing verified_staging_bundle and artifact_bundle protocol v1; native execution is not permitted.",
      true,
    );
  }
  const signature = providerExitSignatureV2(error);
  return blocker(
    "sandbox_execution_failed",
    signature === null
      ? `Sandbox provider failed before a validated result. ${WITHHELD_BLOCKER_DETAIL_V2}`
      : `Sandbox provider process exited with signature 0x${signature.exitCode.toString(16)} on ${signature.launches} launch(es); the provider failed to run the command at all. ${WITHHELD_BLOCKER_DETAIL_V2}`,
    signature === null
      ? "Inspect the provider diagnostic and retry from the prepared action if its fingerprint remains current."
      : "The sandbox provider (for WSL2, wsl.exe) could not start the instance; check the provider's own health, then retry from the prepared action if its fingerprint remains current.",
    true,
  );
}

/** Structural read of a provider exit signature, duck-typed like the code. */
function providerExitSignatureV2(error: unknown): { exitCode: number; launches: number } | null {
  if (sandboxRunnerErrorCodeV2(error) !== "provider_exit_signature") return null;
  const record = error as { exitCode?: unknown; launches?: unknown };
  const exitCode = typeof record.exitCode === "number" && Number.isSafeInteger(record.exitCode) ? record.exitCode : null;
  if (exitCode === null) return null;
  const launches = typeof record.launches === "number" && Number.isSafeInteger(record.launches) && record.launches > 0 ? record.launches : 1;
  return { exitCode, launches };
}

/**
 * The ONLY retriable failure. A timeout is the one code that provably means "we
 * killed it before it answered under our own budget"; an abort is the caller
 * asking us to stop and must be obeyed.
 */
function isRetriableNoVerdictProbeFailureV2(error: unknown): boolean {
  return sandboxRunnerErrorCodeV2(error) === "provider_timeout";
}

export class SandboxManagerV2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxManagerV2Error";
  }
}

export function parseSandboxProviderConfigV2(value: unknown): SandboxProviderConfigV2 {
  const record = exactRecord(value, ["version", "kind", "executable", "priority", "runtimeReference", "runtimeDigest", "wslDistribution", "runtimeRoot"], "sandbox provider");
  if (record.version !== 1) throw new SandboxManagerV2Error("Unsupported sandbox provider version.");
  const kind = enumValue(record.kind, ["docker", "podman", "wsl2", "bubblewrap"] as const, "sandbox provider kind");
  const executable = boundedText(record.executable, "provider executable", 1, 512);
  const expectedExecutable = { docker: "docker", podman: "podman", wsl2: "wsl.exe", bubblewrap: "bwrap" }[kind];
  if (basename(executable).toLowerCase() !== expectedExecutable) {
    throw new SandboxManagerV2Error(`Provider ${kind} requires executable ${expectedExecutable}.`);
  }
  const wslDistribution = record.wslDistribution === null ? null : stableId(record.wslDistribution, "WSL distribution");
  const runtimeRoot = record.runtimeRoot === null ? null : absoluteGuestPath(record.runtimeRoot, "runtime root");
  if (kind === "wsl2" && (!wslDistribution || !runtimeRoot)) throw new SandboxManagerV2Error("WSL2 requires a dedicated distribution and runtime root.");
  if (kind === "bubblewrap" && !runtimeRoot) throw new SandboxManagerV2Error("bubblewrap requires a read-only runtime root.");
  if ((kind === "docker" || kind === "podman") && (wslDistribution || runtimeRoot)) {
    throw new SandboxManagerV2Error("OCI providers cannot declare WSL or host runtime roots.");
  }
  const runtimeReference = boundedText(record.runtimeReference, "runtime reference", 1, 512);
  if (kind === "docker" || kind === "podman") {
    if (
      runtimeReference.includes("@") ||
      runtimeReference.includes("://") ||
      /[\s\0\r\n]/u.test(runtimeReference) ||
      !/^[a-z0-9](?:[a-z0-9._:/-]*[a-z0-9])?$/u.test(runtimeReference)
    ) {
      throw new SandboxManagerV2Error(
        "OCI runtime reference must be a registry image name without a digest; the immutable sha256 digest is stored separately.",
      );
    }
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(runtimeReference)) {
    throw new SandboxManagerV2Error("Local sandbox runtime reference is invalid.");
  }
  return {
    version: 1,
    kind,
    executable,
    priority: boundedInteger(record.priority, "provider priority", 0, 100),
    runtimeReference,
    runtimeDigest: fingerprint(record.runtimeDigest, "sandbox runtime digest"),
    wslDistribution,
    runtimeRoot,
  };
}

export function buildSandboxProbeCommandV2(
  rawProvider: SandboxProviderConfigV2,
): SandboxHostCommandSpecV2 {
  const provider = parseSandboxProviderConfigV2(rawProvider);
  return buildProviderCommand(provider, "boundary_probe", null);
}

export function buildSandboxExecutionCommandV2(
  rawProvider: SandboxProviderConfigV2,
  rawAction: PreparedSandboxActionV2,
): SandboxHostCommandSpecV2 {
  const provider = parseSandboxProviderConfigV2(rawProvider);
  const action = parsePreparedSandboxActionV2(rawAction);
  if (provider.kind !== action.provider) throw new SandboxManagerV2Error("Prepared action provider changed.");
  return buildProviderCommand(provider, "execute", action);
}

export function parsePreparedSandboxActionV2(value: unknown): PreparedSandboxActionV2 {
  const record = exactRecord(value, ["version", "id", "purpose", "provider", "profileKey", "projectId", "commandId", "workspaceId", "repairRequestId", "workspaceManifestFingerprint", "runtimeDigest", "probeFingerprint", "command", "network", "resources", "environment", "stagingManifest", "expectedArtifacts", "preparedAt", "expiresAt", "payloadFingerprint"], "prepared sandbox action");
  if (record.version !== 1) throw new SandboxManagerV2Error("Unsupported prepared sandbox action version.");
  const commandRecord = exactRecord(record.command, ["executable", "args", "cwd", "timeoutMs"], "prepared sandbox command");
  const networkRecord = exactRecord(record.network, ["mode", "credentialPolicy"], "prepared sandbox network");
  const resourcesRecord = exactRecord(record.resources, ["cpuCount", "memoryMb", "pidLimit", "timeoutMs"], "prepared sandbox resources");
  if (networkRecord.credentialPolicy !== "none") throw new SandboxManagerV2Error("Sandbox actions cannot receive application credentials.");
  const purpose = enumValue(record.purpose, ["validation_fast", "validation_targeted", "validation_full", "code_block", "lockfile_restore"] as const, "sandbox purpose");
  const repairRequestId = record.repairRequestId === null
    ? null
    : stableId(record.repairRequestId, "repair request id");
  const validationPurpose = purpose === "validation_fast" ||
    purpose === "validation_targeted" ||
    purpose === "validation_full";
  if (validationPurpose !== (repairRequestId !== null)) {
    throw new SandboxManagerV2Error(
      "Prepared sandbox repair request binding is inconsistent with purpose.",
    );
  }
  const action: PreparedSandboxActionV2 = {
    version: 1,
    id: stableId(record.id, "sandbox action id"),
    purpose,
    provider: enumValue(record.provider, ["docker", "podman", "wsl2", "bubblewrap"] as const, "sandbox provider"),
    profileKey: stableId(record.profileKey, "profile key"),
    projectId: stableId(record.projectId, "project id"),
    commandId: stableId(record.commandId, "command id"),
    workspaceId: stableId(record.workspaceId, "workspace id"),
    repairRequestId,
    workspaceManifestFingerprint: fingerprint(record.workspaceManifestFingerprint, "workspace manifest fingerprint"),
    runtimeDigest: fingerprint(record.runtimeDigest, "runtime digest"),
    probeFingerprint: fingerprint(record.probeFingerprint, "probe fingerprint"),
    command: {
      executable: boundedText(commandRecord.executable, "command executable", 1, 128),
      args: stringArray(commandRecord.args, "command args", 0, 64, 500),
      cwd: safeRelativePath(commandRecord.cwd, "command cwd", true),
      timeoutMs: boundedInteger(commandRecord.timeoutMs, "command timeout", 1_000, 1_800_000),
    },
    network: {
      mode: enumValue(networkRecord.mode, ["disabled", "exact_approval_required"] as const, "network mode"),
      credentialPolicy: "none",
    },
    resources: parseResources(resourcesRecord, boundedInteger(commandRecord.timeoutMs, "command timeout", 1_000, 1_800_000)),
    environment: parseEnvironment(exactOpenRecord(record.environment, "sandbox environment")),
    stagingManifest: parseStagingManifest(array(record.stagingManifest, "staging manifest", 1, MAX_STAGED_FILES) as SandboxStagingEntryV2[]),
    expectedArtifacts: parseExpectedArtifactsWithoutProfile(record.expectedArtifacts),
    preparedAt: isoTimestamp(record.preparedAt, "preparedAt"),
    expiresAt: isoTimestamp(record.expiresAt, "expiresAt"),
    payloadFingerprint: fingerprint(record.payloadFingerprint, "payload fingerprint"),
  };
  const { id: _id, payloadFingerprint, ...core } = action;
  const expectedFingerprint = sha256Canonical(core);
  const expectedId = `sandbox-action-${expectedFingerprint.slice("sha256:".length, "sha256:".length + 32)}`;
  if (payloadFingerprint !== expectedFingerprint || action.id !== expectedId) {
    throw new SandboxManagerV2Error("Prepared sandbox action fingerprint does not match its closed payload.");
  }
  return action;
}

const TRANSIENT_DIAGNOSTIC_BYTES = 16 * 1024;
const TRANSIENT_DIAGNOSTIC_STREAM_BYTES = TRANSIENT_DIAGNOSTIC_BYTES / 2;
const CREDENTIAL_SHAPED_LINE = /(?:authorization|bearer\s+|api[_-]?key|(?:api|access|refresh)?[_-]?token|password|passwd|secret|cookie|credential|(?:gh[pousr]_|github_pat_|lin_api_|sk-(?:proj-)?|glpat-|xox[baprs]-)[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/iu;
const UNSAFE_DIAGNOSTIC_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

function transientDiagnostics(
  stdoutInput: string,
  stderrInput: string,
): SandboxValidationDiagnosticsV1 {
  let redactedLines = 0;
  for (const value of [stdoutInput, stderrInput]) {
    for (const line of value.split(/\r?\n/u)) {
      if (CREDENTIAL_SHAPED_LINE.test(line)) redactedLines += 1;
    }
  }
  const stdoutBytes = Buffer.byteLength(stdoutInput, "utf8");
  const stderrBytes = Buffer.byteLength(stderrInput, "utf8");
  return {
    version: 1,
    stdoutSha256: sha256Text(stdoutInput),
    stderrSha256: sha256Text(stderrInput),
    stdoutBytes,
    stderrBytes,
    truncated:
      stdoutBytes > TRANSIENT_DIAGNOSTIC_BYTES ||
      stderrBytes > TRANSIENT_DIAGNOSTIC_BYTES,
    redactedLines,
  };
}

function transientDiagnosticExcerpt(
  stdoutInput: string,
  stderrInput: string,
): SandboxTransientDiagnosticExcerptV1 {
  const stdout = redactAndBoundDiagnosticStream(stdoutInput);
  const stderr = redactAndBoundDiagnosticStream(stderrInput);
  return {
    version: 1,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    redactedLines: stdout.redactedLines + stderr.redactedLines,
  };
}

function redactAndBoundDiagnosticStream(input: string): {
  text: string;
  truncated: boolean;
  redactedLines: number;
} {
  let redactedLines = 0;
  const sanitized = input
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      if (CREDENTIAL_SHAPED_LINE.test(line)) {
        redactedLines += 1;
        return "[redacted credential-shaped diagnostic line]";
      }
      return line.replace(UNSAFE_DIAGNOSTIC_CONTROL, "�");
    })
    .join("\n");
  if (Buffer.byteLength(sanitized, "utf8") <= TRANSIENT_DIAGNOSTIC_STREAM_BYTES) {
    return { text: sanitized, truncated: false, redactedLines };
  }
  let text = "";
  let bytes = 0;
  for (const character of sanitized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > TRANSIENT_DIAGNOSTIC_STREAM_BYTES) break;
    text += character;
    bytes += characterBytes;
  }
  return {
    text: `${text}\n[diagnostic excerpt truncated]`,
    truncated: true,
    redactedLines,
  };
}

function buildProviderCommand(
  provider: SandboxProviderConfigV2,
  purpose: "boundary_probe" | "execute",
  action: PreparedSandboxActionV2 | null,
): SandboxHostCommandSpecV2 {
  const networkEnabled = action?.network.mode === "exact_approval_required";
  const entryArgs = purpose === "boundary_probe"
    ? [
        "--boundary-probe-json",
        "--expected-runtime-digest",
        provider.runtimeDigest,
      ]
    : [
        "--staging-stdin",
        "--artifacts-stdout",
        "--expected-runtime-digest",
        provider.runtimeDigest,
        "--expected-command-runtime-digest",
        action!.runtimeDigest,
        "--command-cwd",
        action!.command.cwd,
        "--cpu-count",
        String(action!.resources.cpuCount),
        "--memory-mb",
        String(action!.resources.memoryMb),
        "--pid-limit",
        String(action!.resources.pidLimit),
        "--timeout-ms",
        String(action!.resources.timeoutMs),
        "--",
        action!.command.executable,
        ...action!.command.args,
      ];
  let args: string[];
  const guestEnvironment = Object.entries(action?.environment ?? {})
    .sort(([left], [right]) => compareCanonicalText(left, right));
  if (provider.kind === "docker" || provider.kind === "podman") {
    const image = `${provider.runtimeReference}@${provider.runtimeDigest}`;
    args = [
      "run", "--rm",
      "--network", networkEnabled ? "bridge" : "none",
      "--read-only",
      "--user", "65532:65532",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(action?.resources.pidLimit ?? 32),
      "--memory", `${action?.resources.memoryMb ?? 256}m`,
      "--cpus", String(action?.resources.cpuCount ?? 1),
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--tmpfs", "/workspace:rw,nosuid,nodev,size=32m",
      "--env", "HOME=/tmp/home",
      "--env", "PATH=/runtime/bin:/usr/bin:/bin",
      ...guestEnvironment.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--entrypoint", "/opt/agentic/sandbox-entrypoint",
      image,
      ...entryArgs,
    ];
  } else {
    const bwrap = [
      "/usr/bin/bwrap",
      "--unshare-all",
      ...(networkEnabled ? ["--share-net"] : ["--unshare-net"]),
      "--die-with-parent",
      "--new-session",
      "--ro-bind", provider.runtimeRoot!, "/runtime",
      "--ro-bind", `${provider.runtimeRoot!}/bin`, "/bin",
      "--ro-bind", `${provider.runtimeRoot!}/lib`, "/lib",
      "--ro-bind", `${provider.runtimeRoot!}/lib64`, "/lib64",
      "--tmpfs", "/workspace",
      "--tmpfs", "/tmp",
      "--proc", "/proc",
      "--dev", "/dev",
      "--remount-ro", "/",
      "--chdir", "/workspace",
      "--setenv", "HOME", "/tmp/home",
      "--setenv", "PATH", "/runtime/bin",
      ...guestEnvironment.flatMap(([key, value]) => ["--setenv", key, value]),
      "/runtime/bin/sandbox-entrypoint",
      ...entryArgs,
    ];
    args = provider.kind === "wsl2"
      ? ["--distribution", provider.wslDistribution!, "--user", "agentic", "--exec", ...bwrap]
      : bwrap.slice(1);
  }
  if (args.some((argument, index) =>
    /(?:docker\.sock|podman\.sock|\/var\/run)/i.test(argument) ||
    (argument === "/" && args[index - 1] !== "--remount-ro"),
  )) {
    throw new SandboxManagerV2Error("Sandbox command attempted a root or container-socket mount.");
  }
  return {
    version: 1,
    provider: provider.kind,
    purpose,
    executable: provider.executable,
    args,
    shell: false,
    cwd: null,
    // Action environment is passed only to the guest through fixed provider
    // arguments above; it is never inherited by the host provider process.
    env: {},
    timeoutMs: purpose === "boundary_probe"
      ? provider.kind === "wsl2"
        ? WSL2_SANDBOX_PROBE_TIMEOUT_MS_V2
        : PROBE_TIMEOUT_MS
      : action!.resources.timeoutMs,
    stdinMode: purpose === "boundary_probe" ? "none" : "verified_staging_bundle",
    stdoutMode: purpose === "boundary_probe" ? "boundary_probe_json" : "artifact_bundle",
  };
}

function parseBoundaryProof(
  stdout: string,
  expectedRuntimeDigest: string,
): Record<string, unknown> {
  if (Buffer.byteLength(stdout, "utf8") > 16_384) throw new SandboxManagerV2Error("Boundary probe output exceeded 16 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SandboxManagerV2Error("Boundary probe did not return JSON.");
  }
  const proof = exactRecord(parsed, ["version", "uid", "networkBlocked", "rootReadOnly", "hostRootAbsent", "containerSocketAbsent", "runtimeReadOnly", "runtimeDigest", "stagingIsolated", "resourceLimitsEnforced"], "boundary proof");
  if (
    proof.version !== 1 ||
    !Number.isSafeInteger(proof.uid) ||
    (proof.uid as number) <= 0 ||
    proof.networkBlocked !== true ||
    proof.rootReadOnly !== true ||
    proof.hostRootAbsent !== true ||
    proof.containerSocketAbsent !== true ||
    proof.runtimeReadOnly !== true ||
    proof.runtimeDigest !== expectedRuntimeDigest ||
    proof.stagingIsolated !== true ||
    proof.resourceLimitsEnforced !== true
  ) throw new SandboxManagerV2Error("Sandbox boundary probe did not prove every required isolation property.");
  return proof;
}

function assertPurposeMatchesCommand(
  purpose: SandboxActionPurposeV2,
  command: RepositoryValidationCommandV2,
): void {
  const expected = {
    validation_fast: "fast",
    validation_targeted: "targeted",
    validation_full: "full",
    code_block: "targeted",
    lockfile_restore: "bootstrap",
  } as const;
  const strongerValidationFallback =
    (purpose === "validation_fast" && command.phase === "full") ||
    (purpose === "validation_targeted" && ["fast", "full"].includes(command.phase));
  if (command.phase !== expected[purpose] && !strongerValidationFallback) {
    throw new SandboxManagerV2Error(`Sandbox purpose ${purpose} requires a ${expected[purpose]} catalog command.`);
  }
  if (purpose === "lockfile_restore" && (!command.lockfile || command.network !== "exact_approval_required")) {
    throw new SandboxManagerV2Error("Dependency restoration is allowed only from a declared lockfile with exact approval.");
  }
  if (purpose !== "lockfile_restore" && command.network !== "disabled") {
    throw new SandboxManagerV2Error("Code and validation execution must keep network disabled.");
  }
}

function parseStagingManifest(value: readonly SandboxStagingEntryV2[]): SandboxStagingEntryV2[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STAGED_FILES) {
    throw new SandboxManagerV2Error(`Staging manifest requires 1-${MAX_STAGED_FILES} entries.`);
  }
  let total = 0;
  const output = value.map((entry) => {
    const record = exactRecord(entry, ["path", "sha256", "bytes"], "staging entry");
    const bytes = boundedInteger(record.bytes, "staged bytes", 0, MAX_STAGED_FILE_BYTES);
    total += bytes;
    return { path: safeRelativePath(record.path, "staged path", false), sha256: fingerprint(record.sha256, "staged hash"), bytes };
  }).sort((left, right) => compareCanonicalText(left.path, right.path));
  if (total > MAX_STAGED_TOTAL_BYTES) throw new SandboxManagerV2Error("Staging manifest exceeds 10 MB.");
  if (new Set(output.map((entry) => entry.path)).size !== output.length) throw new SandboxManagerV2Error("Staging paths must be unique.");
  return output;
}

function verifyStagedFiles(
  manifest: readonly SandboxStagingEntryV2[],
  files: readonly SandboxStagedFileBytesV2[],
): SandboxStagedFileBytesV2[] {
  if (!Array.isArray(files) || files.length !== manifest.length) throw new SandboxManagerV2Error("Staged file count does not match its manifest.");
  const byPath = new Map(files.map((file) => [safeRelativePath(file.path, "staged file path", false), file]));
  if (byPath.size !== files.length) throw new SandboxManagerV2Error("Staged files contain duplicate paths.");
  return manifest.map((entry) => {
    const file = byPath.get(entry.path);
    if (!file || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength !== entry.bytes || sha256Bytes(file.bytes) !== entry.sha256) {
      throw new SandboxManagerV2Error(`Staged file hash or size mismatch: ${entry.path}.`);
    }
    return { path: entry.path, bytes: file.bytes };
  });
}

function parseExpectedArtifacts(
  value: readonly SandboxExpectedArtifactV2[],
  generatedOutputs: readonly string[],
): SandboxExpectedArtifactV2[] {
  const output = parseExpectedArtifactsWithoutProfile(value);
  for (const artifact of output) {
    if (!generatedOutputs.some((root) => pathMatches(root, artifact.path))) {
      throw new SandboxManagerV2Error(`Artifact is not declared by RepositoryProfileV2: ${artifact.path}.`);
    }
  }
  return output;
}

function parseExpectedArtifactsWithoutProfile(value: unknown): SandboxExpectedArtifactV2[] {
  return array(value, "expected artifacts", 0, 100).map((entry) => {
    const record = exactRecord(entry, ["path", "expectedSha256", "maxBytes", "required"], "expected artifact");
    if (typeof record.required !== "boolean") throw new SandboxManagerV2Error("Artifact required must be boolean.");
    return {
      path: safeRelativePath(record.path, "artifact path", false),
      expectedSha256: record.expectedSha256 === null ? null : fingerprint(record.expectedSha256, "artifact hash"),
      maxBytes: boundedInteger(record.maxBytes, "artifact bytes", 1, MAX_ARTIFACT_BYTES),
      required: record.required,
    };
  }).sort((left, right) => compareCanonicalText(left.path, right.path));
}

function parseEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!SANDBOX_ENVIRONMENT_ALLOWLIST_V2.has(key)) throw new SandboxManagerV2Error(`Sandbox environment key is not allowed: ${key}.`);
    const content = boundedText(raw, `environment ${key}`, 1, 512);
    if (/(?:token|secret|password|authorization|cookie|credential|api[_-]?key)/i.test(content)) {
      throw new SandboxManagerV2Error("Sandbox environment cannot receive application credentials.");
    }
    output[key] = content;
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => compareCanonicalText(left, right)));
}

function parseResources(
  value: Partial<PreparedSandboxActionV2["resources"]> | Record<string, unknown>,
  commandTimeout: number,
): PreparedSandboxActionV2["resources"] {
  const record = value as Record<string, unknown>;
  const allowed = new Set(["cpuCount", "memoryMb", "pidLimit", "timeoutMs"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new SandboxManagerV2Error("Sandbox resources contain unknown keys.");
  const timeoutMs = boundedInteger(record.timeoutMs ?? commandTimeout, "sandbox timeout", 1_000, Math.min(commandTimeout, 1_800_000));
  return {
    cpuCount: boundedInteger(record.cpuCount ?? 1, "CPU count", 1, 4),
    memoryMb: boundedInteger(record.memoryMb ?? 512, "memory MB", 128, 4_096),
    pidLimit: boundedInteger(record.pidLimit ?? 64, "PID limit", 8, 256),
    timeoutMs,
  };
}

function assertBoundedRunnerResult(result: SandboxRunnerResultV2): void {
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) throw new SandboxManagerV2Error("Sandbox result exit code is invalid.");
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string") throw new SandboxManagerV2Error("Sandbox result streams must be strings.");
  if (Buffer.byteLength(result.stdout, "utf8") > 1_048_576 || Buffer.byteLength(result.stderr, "utf8") > 1_048_576) {
    throw new SandboxManagerV2Error("Sandbox result streams exceeded 1 MiB.");
  }
}

function blocker(
  code: SandboxDurableBlockerV2["code"],
  message: string,
  requiredAction: string,
  retryable: boolean,
): SandboxDurableBlockerV2 {
  const core = {
    version: 1 as const,
    code,
    message,
    requiredAction,
    retryable,
    editingAvailable: true as const,
    executionAvailable: false as const,
  };
  return { ...core, fingerprint: sha256Canonical(core) };
}

function safeRelativePath(value: unknown, label: string, allowRoot: boolean): string {
  const path = boundedText(value, label, 1, 500).replace(/\/$/, "");
  if (allowRoot && path === ".") return path;
  if (
    path === "." || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path === ".git" || path.startsWith(".git/")
  ) throw new SandboxManagerV2Error(`${label} must be a safe non-Git repository-relative path.`);
  return path;
}

function absoluteGuestPath(value: unknown, label: string): string {
  const path = boundedText(value, label, 1, 512);
  if (!path.startsWith("/") || path === "/" || path.includes("..") || path.includes("\\")) {
    throw new SandboxManagerV2Error(`${label} must be a non-root absolute guest path.`);
  }
  return path.replace(/\/$/, "");
}

function fingerprint(value: unknown, label: string): string {
  const result = boundedText(value, label, 71, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) throw new SandboxManagerV2Error(`${label} must be canonical sha256 lowercase hex.`);
  return result;
}

function stableId(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new SandboxManagerV2Error(`${label} is invalid.`);
  return result;
}

function isoTimestamp(value: unknown, label: string): string {
  const result = boundedText(value, label, 20, 40);
  if (!Number.isFinite(Date.parse(result)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(result)) throw new SandboxManagerV2Error(`${label} must be timezone-aware ISO-8601.`);
  return result;
}

function boundedText(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw new SandboxManagerV2Error(`${label} must be a string.`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum || /[\0\r\n]/.test(result)) throw new SandboxManagerV2Error(`${label} is invalid.`);
  return result;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new SandboxManagerV2Error(`${label} must be a safe integer in range.`);
  return value as number;
}

function stringArray(value: unknown, label: string, minimum: number, maximum: number, maxLength: number): string[] {
  return array(value, label, minimum, maximum).map((entry) => boundedText(entry, label, 1, maxLength));
}

function array(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new SandboxManagerV2Error(`${label} must contain ${minimum}-${maximum} entries.`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxManagerV2Error(`${label} must be a plain object.`);
  const record = value as Record<string, unknown>;
  if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) throw new SandboxManagerV2Error(`${label} must be a plain object.`);
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) throw new SandboxManagerV2Error(`${label} does not match its closed contract.`);
  return record;
}

function exactOpenRecord(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxManagerV2Error(`${label} must be an object.`);
  return value as Record<string, string>;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new SandboxManagerV2Error(`${label} is invalid.`);
  return value as T;
}

function pathMatches(root: string, path: string): boolean {
  return root === path || path.startsWith(`${root}/`);
}

/**
 * The subset of declared expected artifacts the profile can honour: those at
 * or under one of its declared generated-output roots. `prepareExecution`
 * rejects any other declaration; a host-owned validation run drops it
 * instead, because there the model's artifact list is a hint. Shape and
 * bounds are still checked by the manager on what survives.
 */
export function declaredExpectedArtifactsV2<T extends { path: unknown }>(
  artifacts: readonly T[],
  generatedOutputs: readonly string[],
): T[] {
  const declared: T[] = [];
  for (const artifact of artifacts) {
    if (typeof artifact?.path !== "string") continue;
    const path = artifact.path.replace(/\\/g, "/").replace(/^(?:\.\/)+/u, "");
    if (generatedOutputs.some((root) => pathMatches(root, path))) {
      declared.push({ ...artifact, path });
    }
  }
  return declared;
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1);
}

/**
 * Fixed notice for a blocker whose detail would otherwise be a caught
 * exception's own text.
 *
 * `blocker(...)` stores its message verbatim on `SandboxDurableBlockerV2`, and
 * `CodeExecutionContributionsV2` copies that string into
 * `PreparedActionResultV1.error.message`. From there it reaches the retry plan
 * sent OUTBOUND to the provider, the persisted mission trace, user-visible
 * status and answer, and Run Details. A caught exception's message is arbitrary
 * foreign text: host `ENOENT` strings carry absolute vault paths, spawn
 * failures carry command lines, and readback failures carry note titles.
 *
 * `safeDiagnostic` is NOT sufficient here. It redacts credential-shaped
 * keywords and caps length, which leaves host paths, note titles and command
 * output intact. The typed blocker CODE is the attribution channel; the message
 * must not be a second, unbounded one.
 */
const WITHHELD_BLOCKER_DETAIL_V2 =
  "The underlying error text is withheld because it can carry host paths, command output, or credentials; use the blocker code to attribute it.";

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:token|secret|password|authorization|cookie|credential|api[_-]?key)\s*[=:]\s*\S+/gi, "credential=[REDACTED]")
    .slice(0, 1_000);
}

function summarizeUnavailableProviders(
  statuses: readonly SandboxProviderStatusV2[],
): string {
  return statuses
    .filter((status) => status.state !== "verified" && status.state !== "unprobed")
    .map((status) =>
      `${status.provider} ${status.state}: ${safeDiagnostic(status.diagnostic).slice(0, 240)}`,
    )
    .join("; ")
    .slice(0, 1_000);
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareCanonicalText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new SandboxManagerV2Error("Canonical JSON contains an unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new SandboxManagerV2Error("Canonical JSON contains an unsupported value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
