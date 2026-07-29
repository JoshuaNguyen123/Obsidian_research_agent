/**
 * Host-provisioned sandbox binding adoption.
 *
 * `scripts/setup-wsl2-sandbox.ps1` (and the equivalent Podman/bubblewrap
 * provisioning) already installs an immutable runtime and records its exact
 * non-secret identity — executable, runtime reference, SHA-256 digest, guest
 * distribution, and read-only runtime root — in the host user environment.
 * Before this module the production plugin ignored those values entirely: only
 * the manual settings modal could populate `sandbox.providerConfigs`, so a
 * fully provisioned host still reported `providerConfigs: []` and every
 * generated-code mission died at `code_validate_fast` with
 * "No sandbox provider has passed its boundary probe." The e2e lanes hid the
 * gap because they called `configureSandboxProvider` themselves.
 *
 * Security posture is unchanged. These variables only *nominate* a candidate
 * provider; they grant nothing. `SandboxManagerV2.probeProviders` remains the
 * sole authority for `executionAvailable` and still requires the full boundary
 * proof (non-root uid, blocked network, read-only root, absent host root and
 * container socket, read-only runtime at the pinned digest, isolated staging,
 * enforced resource limits). The environment is written by the same local user
 * who could otherwise type the same values into the settings modal, so
 * adoption crosses no privilege boundary.
 */

import {
  parseSandboxProviderConfigV2,
  WSL2_SANDBOX_PROBE_TIMEOUT_MS_V2,
  type SandboxProviderConfigV2,
  type SandboxProviderKindV2,
} from "./SandboxManager";

export type HostProvisionedSandboxPlatformV1 = NodeJS.Platform | string;

export interface HostProvisionedSandboxBindingV1 {
  provider: SandboxProviderConfigV2;
  /** Exact environment variable names read, for non-secret diagnostics. */
  variableNames: string[];
}

export type HostProvisionedSandboxAdoptionReasonV1 =
  | "no_host_binding"
  | "already_bound"
  | "missing_binding"
  | "binding_changed";

export interface HostProvisionedSandboxAdoptionDecisionV1 {
  adopt: boolean;
  reason: HostProvisionedSandboxAdoptionReasonV1;
}

const PROVIDER_KINDS = ["docker", "podman", "wsl2", "bubblewrap"] as const;

const PLATFORM_DEFAULT_PROVIDER: Readonly<
  Record<string, SandboxProviderKindV2>
> = Object.freeze({
  win32: "wsl2",
  darwin: "podman",
  linux: "bubblewrap",
});

const PROVIDER_EXECUTABLE: Readonly<Record<SandboxProviderKindV2, string>> =
  Object.freeze({
    docker: "docker",
    podman: "podman",
    wsl2: "wsl.exe",
    bubblewrap: "bwrap",
  });

const PROVIDER_PRIORITY: Readonly<Record<SandboxProviderKindV2, number>> =
  Object.freeze({ docker: 10, podman: 20, wsl2: 30, bubblewrap: 40 });

/**
 * Canonical production names first, then the `_CI_` names that the existing
 * provisioning scripts already persist to the Windows user environment. Both
 * describe the same non-secret local runtime identity.
 */
const VARIABLE_CANDIDATES = Object.freeze({
  provider: ["AGENTIC_SANDBOX_PROVIDER", "AGENTIC_SANDBOX_CI_PROVIDER"],
  executable: ["AGENTIC_SANDBOX_EXECUTABLE", "AGENTIC_SANDBOX_CI_EXECUTABLE"],
  runtimeReference: [
    "AGENTIC_SANDBOX_RUNTIME_REFERENCE",
    "AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE",
  ],
  runtimeDigest: [
    "AGENTIC_SANDBOX_RUNTIME_DIGEST",
    "AGENTIC_SANDBOX_CI_RUNTIME_DIGEST",
  ],
  wslDistribution: [
    "AGENTIC_SANDBOX_WSL_DISTRIBUTION",
    "AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION",
  ],
  runtimeRoot: [
    "AGENTIC_SANDBOX_RUNTIME_ROOT",
    "AGENTIC_SANDBOX_CI_RUNTIME_ROOT",
  ],
} as const);

/** Every variable name this module reads. Non-secret; safe to surface. */
export const HOST_PROVISIONED_SANDBOX_VARIABLE_NAMES_V1: readonly string[] =
  Object.freeze(Object.values(VARIABLE_CANDIDATES).flatMap((names) => [...names]));

/**
 * The foreground mission gate must never abort a valid provider before that
 * provider's own fixed process budget expires. WSL2 is the longest bounded
 * probe; the additional margin covers durable state persistence and readiness
 * projection before AgentView evaluates the gate.
 */
export const HOST_PROVISIONED_SANDBOX_READINESS_TIMEOUT_MS_V1 =
  WSL2_SANDBOX_PROBE_TIMEOUT_MS_V2 + 15_000;

type EnvironmentRecordV1 = Readonly<Record<string, string | undefined>>;

interface ResolvedValueV1 {
  value: string;
  name: string;
}

function readFirst(
  env: EnvironmentRecordV1,
  candidates: readonly string[],
): ResolvedValueV1 | null {
  for (const name of candidates) {
    const raw = env[name];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value.length > 0 && value.length <= 512) return { value, name };
  }
  return null;
}

function resolveKind(
  env: EnvironmentRecordV1,
  platform: HostProvisionedSandboxPlatformV1,
): ResolvedValueV1 | null {
  const declared = readFirst(env, VARIABLE_CANDIDATES.provider);
  if (declared) {
    const normalized = declared.value.toLowerCase();
    return PROVIDER_KINDS.some((kind) => kind === normalized)
      ? { value: normalized, name: declared.name }
      : null;
  }
  const inferred = PLATFORM_DEFAULT_PROVIDER[platform];
  return inferred ? { value: inferred, name: "" } : null;
}

/**
 * Build a provider configuration from the host environment, or null when the
 * host declares nothing usable. Never throws: a partial or malformed
 * environment simply means "no host binding", so plugin load is never at risk.
 */
export function readHostProvisionedSandboxBindingV1(
  env: EnvironmentRecordV1,
  platform: HostProvisionedSandboxPlatformV1,
): HostProvisionedSandboxBindingV1 | null {
  const kindValue = resolveKind(env, platform);
  if (!kindValue) return null;
  const kind = kindValue.value as SandboxProviderKindV2;

  const runtimeReference = readFirst(env, VARIABLE_CANDIDATES.runtimeReference);
  const runtimeDigest = readFirst(env, VARIABLE_CANDIDATES.runtimeDigest);
  if (!runtimeReference || !runtimeDigest) return null;

  const executable = readFirst(env, VARIABLE_CANDIDATES.executable);
  const wslDistribution =
    kind === "wsl2" ? readFirst(env, VARIABLE_CANDIDATES.wslDistribution) : null;
  const runtimeRoot =
    kind === "wsl2" || kind === "bubblewrap"
      ? readFirst(env, VARIABLE_CANDIDATES.runtimeRoot)
      : null;
  if (kind === "wsl2" && (!wslDistribution || !runtimeRoot)) return null;
  if (kind === "bubblewrap" && !runtimeRoot) return null;

  const variableNames = [
    kindValue.name,
    executable?.name ?? "",
    runtimeReference.name,
    runtimeDigest.name,
    wslDistribution?.name ?? "",
    runtimeRoot?.name ?? "",
  ].filter((name) => name.length > 0);

  try {
    // The strict production parser is the only accepted validator: digest
    // shape, executable basename, guest-path form, and provider/field
    // coherence all fail closed here rather than at probe time.
    const provider = parseSandboxProviderConfigV2({
      version: 1,
      kind,
      executable: executable?.value ?? PROVIDER_EXECUTABLE[kind],
      priority: PROVIDER_PRIORITY[kind],
      runtimeReference: runtimeReference.value,
      runtimeDigest: runtimeDigest.value,
      wslDistribution: wslDistribution?.value ?? null,
      runtimeRoot: runtimeRoot?.value ?? null,
    });
    return { provider, variableNames };
  } catch {
    return null;
  }
}

function sameProvider(
  left: SandboxProviderConfigV2,
  right: SandboxProviderConfigV2,
): boolean {
  return (
    left.kind === right.kind &&
    left.executable === right.executable &&
    left.runtimeReference === right.runtimeReference &&
    left.runtimeDigest === right.runtimeDigest &&
    left.wslDistribution === right.wslDistribution &&
    left.runtimeRoot === right.runtimeRoot
  );
}

/**
 * Adopt when the host declares a binding the durable state does not already
 * hold. A re-provisioned runtime reports a new digest, so an existing but
 * stale binding of the same kind is refreshed instead of left permanently
 * failing its probe. Providers of other kinds are never touched, so a
 * hand-configured binding keeps its own entry.
 */
export function hostProvisionedSandboxAdoptionDecisionV1(input: {
  configured: readonly SandboxProviderConfigV2[];
  binding: SandboxProviderConfigV2 | null;
}): HostProvisionedSandboxAdoptionDecisionV1 {
  if (!input.binding) return { adopt: false, reason: "no_host_binding" };
  const existing = input.configured.find(
    (candidate) => candidate.kind === input.binding!.kind,
  );
  if (!existing) return { adopt: true, reason: "missing_binding" };
  return sameProvider(existing, input.binding)
    ? { adopt: false, reason: "already_bound" }
    : { adopt: true, reason: "binding_changed" };
}
