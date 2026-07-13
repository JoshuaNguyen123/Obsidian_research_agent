import {
  AGENTIC_RESEARCHER_CORE_API_MAJOR,
  AGENTIC_RESEARCHER_CORE_API_MINOR,
  ExtensionRegistrationErrorV1,
  ExtensionUnavailableErrorV1,
  type BackgroundHandlerContributionV1,
  type CoreLifecycleStateV1,
  type ExpectedExtensionStatusV1,
  type ExpectedExtensionV1,
  type ExtensionContributionKindV1,
  type ExtensionContributionV1,
  type ExtensionManifestV1,
  type ExtensionMissionSnapshotV1,
  type ExtensionRegistrationTokenV1,
  type ExtensionToolContributionV1,
  type MissionExecutorContributionV1,
  type MissionVerifierContributionV1,
  type RegisterExtensionRequestV1,
  type RegisteredContributionV1,
  type SerializerContributionV1,
  type SettingsContributionV1,
  type StatusContributionV1,
} from "../../packages/core-api/src";

interface RegisteredExtensionRecord {
  manifest: Readonly<ExtensionManifestV1>;
  token: ExtensionRegistrationTokenV1;
  controller: AbortController;
  contributions: ReadonlyArray<ExtensionContributionV1>;
  contributionKeys: ReadonlyArray<string>;
  toolNames: ReadonlyArray<string>;
}

export interface ExtensionRegistryOptions {
  getCoreState(): CoreLifecycleStateV1;
  now?: () => Date;
  /** Host catalog ownership policy, enforced before a contribution is published. */
  toolNameReservations?: Iterable<ExtensionToolNameReservation>;
}

export interface ExtensionToolNameReservation {
  name: string;
  /** Null means core-only; otherwise only this extension may claim the name. */
  ownerExtensionId: string | null;
}

/**
 * Transactional registry for soft-dependent extensions. Registration validates
 * the complete contribution batch before publishing any capability.
 */
export class ExtensionRegistry {
  private readonly extensions = new Map<string, RegisteredExtensionRecord>();
  private readonly activeTokens = new Map<
    ExtensionRegistrationTokenV1,
    RegisteredExtensionRecord
  >();
  private readonly contributionOwners = new Map<string, string>();
  private readonly toolOwners = new Map<string, string>();
  private readonly incompatibilities = new Map<string, string>();
  private readonly lastUnavailability = new Map<string, string>();
  private readonly toolNameReservations: ReadonlyMap<string, string | null>;
  private readonly now: () => Date;
  private nextRegistrationId = 1;

  constructor(private readonly options: ExtensionRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.toolNameReservations = buildToolNameReservations(
      options.toolNameReservations ?? [],
    );
  }

  registerExtension(request: RegisterExtensionRequestV1): ExtensionRegistrationTokenV1 {
    this.assertRegistrationState();
    const manifest = validateManifest(request.manifest);
    this.assertApiCompatibility(manifest);

    if (this.extensions.has(manifest.id)) {
      throw new ExtensionRegistrationErrorV1(
        "duplicate_extension",
        `Extension is already registered: ${manifest.id}`,
      );
    }
    if (!Array.isArray(request.contributions)) {
      throw new ExtensionRegistrationErrorV1(
        "invalid_contribution",
        "Extension contributions must be an array.",
      );
    }

    const contributionKeys = new Set<string>();
    const toolNames = new Set<string>();
    for (const contribution of request.contributions) {
      validateContribution(contribution, manifest.id);
      const key = contributionKey(contribution);
      if (contributionKeys.has(key) || this.contributionOwners.has(key)) {
        throw new ExtensionRegistrationErrorV1(
          "duplicate_contribution",
          `Duplicate extension contribution: ${key}`,
        );
      }
      contributionKeys.add(key);

      if (contribution.descriptor.kind === "tool") {
        const name = (contribution as ExtensionToolContributionV1).tool.name;
        const hasReservation = this.toolNameReservations.has(name);
        const reservedOwner = this.toolNameReservations.get(name) ?? null;
        if (hasReservation && reservedOwner !== manifest.id) {
          throw new ExtensionRegistrationErrorV1(
            "duplicate_contribution",
            reservedOwner
              ? `Extension tool name ${name} is reserved for ${reservedOwner}.`
              : `Extension tool name is reserved by core: ${name}`,
          );
        }
        if (toolNames.has(name) || this.toolOwners.has(name)) {
          throw new ExtensionRegistrationErrorV1(
            "duplicate_contribution",
            `Duplicate extension tool name: ${name}`,
          );
        }
        toolNames.add(name);
      }
    }

    const controller = new AbortController();
    const token = Object.freeze<ExtensionRegistrationTokenV1>({
      version: 1,
      id: `extension-registration:${manifest.id}:${this.nextRegistrationId++}`,
      extensionId: manifest.id,
      apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
      apiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
      issuedAt: this.now().toISOString(),
      signal: controller.signal,
    });
    const contributions = Object.freeze(
      request.contributions.map((contribution) =>
        this.cloneAndGuardContribution(contribution, token),
      ),
    );
    const record: RegisteredExtensionRecord = {
      manifest: freezeJsonClone(manifest),
      token,
      controller,
      contributions,
      contributionKeys: Object.freeze([...contributionKeys]),
      toolNames: Object.freeze([...toolNames]),
    };

    // Publish only after every contribution and wrapper has been built.
    this.extensions.set(manifest.id, record);
    this.activeTokens.set(token, record);
    for (const key of record.contributionKeys) {
      this.contributionOwners.set(key, manifest.id);
    }
    for (const name of record.toolNames) {
      this.toolOwners.set(name, manifest.id);
    }
    this.incompatibilities.delete(manifest.id);
    this.lastUnavailability.delete(manifest.id);
    return token;
  }

  unregisterExtension(
    token: ExtensionRegistrationTokenV1,
    reason = "extension_unregistered",
  ): boolean {
    const record = this.activeTokens.get(token);
    if (!record || record.token !== token) {
      return false;
    }

    this.activeTokens.delete(token);
    this.extensions.delete(record.manifest.id);
    for (const key of record.contributionKeys) {
      if (this.contributionOwners.get(key) === record.manifest.id) {
        this.contributionOwners.delete(key);
      }
    }
    for (const name of record.toolNames) {
      if (this.toolOwners.get(name) === record.manifest.id) {
        this.toolOwners.delete(name);
      }
    }
    record.controller.abort(reason);
    this.lastUnavailability.set(
      record.manifest.id,
      `Last registration ended: ${reason}.`,
    );
    return true;
  }

  unregisterAll(reason = "core_unloading"): number {
    const tokens = [...this.activeTokens.keys()];
    for (const token of tokens) {
      this.unregisterExtension(token, reason);
    }
    return tokens.length;
  }

  isTokenActive(token: ExtensionRegistrationTokenV1): boolean {
    const record = this.activeTokens.get(token);
    return Boolean(record && record.token === token && !token.signal.aborted);
  }

  getRegisteredExtensionIds(): ReadonlyArray<string> {
    return Object.freeze([...this.extensions.keys()]);
  }

  createMissionSnapshot(missionId: string): ExtensionMissionSnapshotV1 {
    if (!missionId.trim()) {
      throw new TypeError("Mission snapshot requires a non-empty mission id.");
    }
    const contributions = [...this.extensions.values()]
      .filter((record) => this.isTokenActive(record.token))
      .flatMap((record) =>
        record.contributions.map((contribution) =>
          Object.freeze({
            extensionId: record.manifest.id,
            token: record.token,
            contribution,
          }),
        ),
      );

    return Object.freeze({
      version: 1,
      missionId: missionId.trim(),
      createdAt: this.now().toISOString(),
      apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
      apiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
      tools: freezeContributions<ExtensionToolContributionV1>(contributions, "tool"),
      executors: freezeContributions<MissionExecutorContributionV1>(
        contributions,
        "mission_executor",
      ),
      verifiers: freezeContributions<MissionVerifierContributionV1>(
        contributions,
        "mission_verifier",
      ),
      settings: freezeContributions<SettingsContributionV1>(contributions, "settings"),
      statuses: freezeContributions<StatusContributionV1>(contributions, "status"),
      backgroundHandlers: freezeContributions<BackgroundHandlerContributionV1>(
        contributions,
        "background_handler",
      ),
      serializers: freezeContributions<SerializerContributionV1>(
        contributions,
        "serializer",
      ),
    });
  }

  getExpectedExtensionStatuses(
    expected: ReadonlyArray<ExpectedExtensionV1>,
  ): ReadonlyArray<ExpectedExtensionStatusV1> {
    return Object.freeze(
      expected.map((item) => {
        const record = this.extensions.get(item.id);
        if (record && this.isTokenActive(record.token)) {
          return Object.freeze({
            ...item,
            availability: "registered" as const,
            registeredVersion: record.manifest.version,
            message: `${item.displayName} is registered.`,
          });
        }
        const incompatible = this.incompatibilities.get(item.id);
        const lastUnavailability = this.lastUnavailability.get(item.id);
        return Object.freeze({
          ...item,
          availability: incompatible ? ("incompatible" as const) : ("missing" as const),
          message:
            incompatible ??
            (lastUnavailability
              ? `${item.displayName} is not registered. ${lastUnavailability}`
              : `${item.displayName} is not registered.`),
        });
      }),
    );
  }

  private assertRegistrationState(): void {
    const state = this.options.getCoreState();
    if (state === "loading") {
      throw new ExtensionRegistrationErrorV1(
        "core_not_ready",
        "Core extension API is still loading.",
      );
    }
    if (state === "unloading") {
      throw new ExtensionRegistrationErrorV1(
        "core_unloading",
        "Core extension API is unloading.",
      );
    }
  }

  private assertApiCompatibility(manifest: Readonly<ExtensionManifestV1>): void {
    if (manifest.apiMajor !== AGENTIC_RESEARCHER_CORE_API_MAJOR) {
      const message =
        `Extension ${manifest.id} requires core API major ${manifest.apiMajor}; ` +
        `core provides ${AGENTIC_RESEARCHER_CORE_API_MAJOR}.`;
      this.incompatibilities.set(manifest.id, message);
      throw new ExtensionRegistrationErrorV1("api_major_mismatch", message);
    }
    if (manifest.apiMinor > AGENTIC_RESEARCHER_CORE_API_MINOR) {
      const message =
        `Extension ${manifest.id} requires core API ${manifest.apiMajor}.${manifest.apiMinor}; ` +
        `core provides ${AGENTIC_RESEARCHER_CORE_API_MAJOR}.${AGENTIC_RESEARCHER_CORE_API_MINOR}.`;
      this.incompatibilities.set(manifest.id, message);
      throw new ExtensionRegistrationErrorV1("api_minor_unsupported", message);
    }
  }

  private cloneAndGuardContribution(
    contribution: ExtensionContributionV1,
    token: ExtensionRegistrationTokenV1,
  ): ExtensionContributionV1 {
    const descriptor = freezeJsonClone(contribution.descriptor);
    switch (contribution.descriptor.kind) {
      case "tool": {
        const source = contribution as ExtensionToolContributionV1;
        const tool = source.tool;
        return Object.freeze({
          descriptor,
          tool: Object.freeze({
            name: tool.name,
            description: tool.description,
            parameters: freezeJsonClone(tool.parameters),
            descriptor: freezeJsonClone(tool.descriptor),
            execute: this.guard(token, tool.execute),
            ...(tool.prepare ? { prepare: this.guard(token, tool.prepare) } : {}),
            ...(tool.executePrepared
              ? { executePrepared: this.guard(token, tool.executePrepared) }
              : {}),
            ...(tool.reconcile ? { reconcile: this.guard(token, tool.reconcile) } : {}),
          }),
        }) as ExtensionToolContributionV1;
      }
      case "mission_executor": {
        const source = contribution as MissionExecutorContributionV1;
        return Object.freeze({
          descriptor,
          execute: this.guard(token, source.execute),
        }) as MissionExecutorContributionV1;
      }
      case "mission_verifier": {
        const source = contribution as MissionVerifierContributionV1;
        return Object.freeze({
          descriptor,
          verify: this.guard(token, source.verify),
        }) as MissionVerifierContributionV1;
      }
      case "settings": {
        const source = contribution as SettingsContributionV1;
        return Object.freeze({
          descriptor,
          section: freezeJsonClone(source.section),
        }) as SettingsContributionV1;
      }
      case "status": {
        const source = contribution as StatusContributionV1;
        return Object.freeze({
          descriptor,
          readStatus: this.guard(token, source.readStatus),
        }) as StatusContributionV1;
      }
      case "background_handler": {
        const source = contribution as BackgroundHandlerContributionV1;
        return Object.freeze({
          descriptor,
          handle: this.guard(token, source.handle),
        }) as BackgroundHandlerContributionV1;
      }
      case "serializer": {
        const source = contribution as SerializerContributionV1;
        return Object.freeze({
          descriptor,
          target: source.target,
          type: source.type,
          serialize: this.guard(token, source.serialize),
          deserialize: this.guard(token, source.deserialize),
        }) as SerializerContributionV1;
      }
    }
  }

  private guard<TArgs extends unknown[], TResult>(
    token: ExtensionRegistrationTokenV1,
    handler: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      this.assertTokenActive(token);
      const result = await handler(...args);
      this.assertTokenActive(token);
      return result;
    };
  }

  private assertTokenActive(token: ExtensionRegistrationTokenV1): void {
    if (!this.isTokenActive(token)) {
      throw new ExtensionUnavailableErrorV1(token.extensionId);
    }
  }
}

function validateManifest(manifest: ExtensionManifestV1): Readonly<ExtensionManifestV1> {
  if (!manifest || typeof manifest !== "object") {
    throw new ExtensionRegistrationErrorV1("invalid_manifest", "Extension manifest is required.");
  }
  if (!isExtensionId(manifest.id)) {
    throw new ExtensionRegistrationErrorV1(
      "invalid_manifest",
      "Extension id must use lowercase letters, digits, dots, or hyphens.",
    );
  }
  if (!manifest.displayName?.trim() || !manifest.version?.trim()) {
    throw new ExtensionRegistrationErrorV1(
      "invalid_manifest",
      "Extension display name and version are required.",
    );
  }
  if (!Number.isInteger(manifest.apiMajor) || !Number.isInteger(manifest.apiMinor)) {
    throw new ExtensionRegistrationErrorV1(
      "invalid_manifest",
      "Extension API major and minor versions must be integers.",
    );
  }
  return freezeJsonClone({
    id: manifest.id,
    displayName: manifest.displayName.trim(),
    version: manifest.version.trim(),
    apiMajor: manifest.apiMajor,
    apiMinor: manifest.apiMinor,
  });
}

function buildToolNameReservations(
  reservations: Iterable<ExtensionToolNameReservation>,
): ReadonlyMap<string, string | null> {
  const result = new Map<string, string | null>();
  for (const reservation of reservations) {
    if (!isContributionId(reservation?.name)) {
      throw new TypeError("Reserved extension tool names must be valid tool names.");
    }
    if (
      reservation.ownerExtensionId !== null &&
      !isExtensionId(reservation.ownerExtensionId)
    ) {
      throw new TypeError(
        `Reserved tool owner is not a valid extension id: ${reservation.ownerExtensionId}`,
      );
    }
    if (
      result.has(reservation.name) &&
      result.get(reservation.name) !== reservation.ownerExtensionId
    ) {
      throw new TypeError(
        `Conflicting extension tool reservation for ${reservation.name}.`,
      );
    }
    result.set(reservation.name, reservation.ownerExtensionId);
  }
  return result;
}

function validateContribution(
  contribution: ExtensionContributionV1,
  extensionId: string,
): void {
  if (!contribution || typeof contribution !== "object" || !contribution.descriptor) {
    throw invalidContribution("Every contribution requires a descriptor.");
  }
  const descriptor = contribution.descriptor;
  if (
    descriptor.version !== 1 ||
    !isContributionKind(descriptor.kind) ||
    !isContributionId(descriptor.id) ||
    !descriptor.displayName?.trim()
  ) {
    throw invalidContribution("Contribution descriptor is invalid.");
  }

  switch (descriptor.kind) {
    case "tool": {
      const tool = (contribution as ExtensionToolContributionV1).tool;
      if (
        !tool ||
        !isContributionId(tool.name) ||
        (descriptor.id !== tool.name &&
          descriptor.id !== `${extensionId}:${tool.name}`) ||
        tool.descriptor?.version !== 1 ||
        tool.descriptor.name !== tool.name ||
        typeof tool.execute !== "function"
      ) {
        throw invalidContribution(
          "Tool contribution id must be the tool name or its extension-qualified name, and the action descriptor and execute handler must match.",
        );
      }
      validateToolDescriptor(tool.descriptor, tool);
      if (
        tool.descriptor.execution.preparation === "required" &&
        (typeof tool.prepare !== "function" || typeof tool.executePrepared !== "function")
      ) {
        throw invalidContribution(
          `Prepared extension tool ${tool.name} requires prepare and executePrepared handlers.`,
        );
      }
      if (
        tool.descriptor.durability.reconciliation === "required" &&
        typeof tool.reconcile !== "function"
      ) {
        throw invalidContribution(
          `Reconciled extension tool ${tool.name} requires a reconcile handler.`,
        );
      }
      assertJsonCompatible(tool.parameters, `tool ${tool.name} parameters`);
      assertJsonCompatible(tool.descriptor, `tool ${tool.name} descriptor`);
      return;
    }
    case "mission_executor":
      assertHandler(contribution, "execute");
      return;
    case "mission_verifier":
      assertHandler(contribution, "verify");
      return;
    case "settings": {
      const section = (contribution as SettingsContributionV1).section;
      if (!section?.id?.trim() || !section.title?.trim() || !Array.isArray(section.fields)) {
        throw invalidContribution("Settings contribution section is invalid.");
      }
      assertJsonCompatible(section, `settings contribution ${descriptor.id}`);
      return;
    }
    case "status":
      assertHandler(contribution, "readStatus");
      return;
    case "background_handler":
      assertHandler(contribution, "handle");
      return;
    case "serializer": {
      const serializer = contribution as SerializerContributionV1;
      if (
        (serializer.target !== "receipt" && serializer.target !== "pending_action") ||
        !serializer.type?.trim() ||
        typeof serializer.serialize !== "function" ||
        typeof serializer.deserialize !== "function"
      ) {
        throw invalidContribution("Serializer contribution is invalid.");
      }
      return;
    }
  }
}

function validateToolDescriptor(
  descriptor: ExtensionToolContributionV1["tool"]["descriptor"],
  tool: ExtensionToolContributionV1["tool"],
): void {
  const systems = new Set([
    "vault", "web", "browser", "workspace", "git", "linear", "github",
  ]);
  const actions = new Set([
    "read", "list", "search", "create", "append", "update", "replace",
    "move", "archive", "unarchive", "trash", "delete", "restore", "link",
    "unlink", "validate", "promote", "merge", "execute", "install",
    "commit", "integrate", "publish",
  ]);
  const effects = new Set([
    "read", "reversible_mutation", "destructive_mutation", "execution", "publish",
  ]);
  const risks = new Set(["low", "medium", "high", "critical"]);
  const fallbacks = new Set(["none", "exact", "double_exact", "block"]);
  const preparations = new Set(["none", "optional", "required"]);
  const readbacks = new Set(["none", "optional", "required"]);
  const reconciliations = new Set(["none", "optional", "required"]);
  const principals = new Set([
    "host", "single_agent", "lead", "researcher", "code_worker",
  ]);
  if (
    !descriptor?.capability ||
    !systems.has(descriptor.capability.system) ||
    !actions.has(descriptor.capability.action) ||
    !isContributionId(descriptor.capability.resourceType) ||
    !effects.has(descriptor.effect) ||
    !risks.has(descriptor.risk)
  ) {
    throw invalidContribution(`Tool ${tool.name} capability descriptor is invalid.`);
  }
  if (
    !descriptor.approval ||
    typeof descriptor.approval.allowPromptGrant !== "boolean" ||
    typeof descriptor.approval.allowPersistentGrant !== "boolean" ||
    !fallbacks.has(descriptor.approval.fallback)
  ) {
    throw invalidContribution(`Tool ${tool.name} approval policy is invalid.`);
  }
  if (
    !descriptor.execution ||
    !preparations.has(descriptor.execution.preparation) ||
    typeof descriptor.execution.cacheable !== "boolean" ||
    typeof descriptor.execution.parallelSafe !== "boolean" ||
    (descriptor.execution.desktopOnly !== undefined &&
      typeof descriptor.execution.desktopOnly !== "boolean")
  ) {
    throw invalidContribution(`Tool ${tool.name} execution policy is invalid.`);
  }
  if (
    !descriptor.durability ||
    typeof descriptor.durability.journal !== "boolean" ||
    typeof descriptor.durability.receipt !== "boolean" ||
    !readbacks.has(descriptor.durability.readback) ||
    !reconciliations.has(descriptor.durability.reconciliation)
  ) {
    throw invalidContribution(`Tool ${tool.name} durability policy is invalid.`);
  }
  if (
    !Array.isArray(descriptor.allowedPrincipals) ||
    descriptor.allowedPrincipals.length === 0 ||
    descriptor.allowedPrincipals.some((principal) => !principals.has(principal)) ||
    new Set(descriptor.allowedPrincipals).size !== descriptor.allowedPrincipals.length
  ) {
    throw invalidContribution(`Tool ${tool.name} principal policy is invalid.`);
  }
  const readActions = new Set(["read", "list", "search", "validate"]);
  if (descriptor.effect === "read" && !readActions.has(descriptor.capability.action)) {
    throw invalidContribution(`Read tool ${tool.name} declares a mutating action.`);
  }
  if (
    descriptor.effect !== "read" &&
    (descriptor.execution.preparation !== "required" ||
      descriptor.approval.fallback === "none" ||
      !descriptor.durability.journal ||
      !descriptor.durability.receipt ||
      !descriptor.receiptKind)
  ) {
    throw invalidContribution(
      `Mutating, execution, and publish tool ${tool.name} requires preparation, approval fallback, journaling, and receipts.`,
    );
  }
  if (
    descriptor.durability.readback === "required" &&
    !descriptor.durability.receipt
  ) {
    throw invalidContribution(`Tool ${tool.name} requires readback without a receipt.`);
  }
  if (
    descriptor.durability.reconciliation === "required" &&
    (!descriptor.durability.journal ||
      !descriptor.durability.receipt ||
      descriptor.durability.readback !== "required")
  ) {
    throw invalidContribution(
      `Tool ${tool.name} reconciliation requires journaled receipt and readback proof.`,
    );
  }
}

function assertHandler(contribution: object, name: string): void {
  if (typeof (contribution as Record<string, unknown>)[name] !== "function") {
    throw invalidContribution(`Contribution requires a ${name} handler.`);
  }
}

function invalidContribution(message: string): ExtensionRegistrationErrorV1 {
  return new ExtensionRegistrationErrorV1("invalid_contribution", message);
}

function contributionKey(contribution: ExtensionContributionV1): string {
  return `${contribution.descriptor.kind}:${contribution.descriptor.id}`;
}

function isExtensionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{1,127}$/.test(value);
}

function isContributionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function isContributionKind(value: unknown): value is ExtensionContributionKindV1 {
  return [
    "tool",
    "mission_executor",
    "mission_verifier",
    "settings",
    "status",
    "background_handler",
    "serializer",
  ].includes(String(value));
}

function freezeContributions<T extends ExtensionContributionV1>(
  contributions: ReadonlyArray<RegisteredContributionV1<ExtensionContributionV1>>,
  kind: ExtensionContributionKindV1,
): ReadonlyArray<RegisteredContributionV1<T>> {
  return Object.freeze(
    contributions.filter((item) => item.contribution.descriptor.kind === kind),
  ) as ReadonlyArray<RegisteredContributionV1<T>>;
}

function freezeJsonClone<T>(value: T): Readonly<T> {
  assertJsonCompatible(value, "extension metadata");
  const clone = JSON.parse(JSON.stringify(value)) as T;
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function assertJsonCompatible(value: unknown, label: string, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw invalidContribution(`${label} must contain JSON-compatible values.`);
  }
  if (seen.has(value)) {
    throw invalidContribution(`${label} must not contain circular values.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonCompatible(item, label, seen);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidContribution(`${label} must contain plain JSON objects.`);
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      if (nested !== undefined) assertJsonCompatible(nested, label, seen);
    }
  } finally {
    seen.delete(value);
  }
}
