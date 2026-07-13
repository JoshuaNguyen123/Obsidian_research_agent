export const CODE_EXTENSION_ID = "agentic-researcher-code" as const;
export const INTEGRATIONS_EXTENSION_ID =
  "agentic-researcher-integrations" as const;
export const COMPANION_EXTENSION_ID = "agentic-researcher-companion" as const;

export interface OptionalExtensionCapabilityStateV1 {
  code: boolean;
  integrations: boolean;
  companion: boolean;
}

/**
 * Converts the live registration set into the only optional-domain switches
 * core may use. Installed files and saved settings never imply availability.
 */
export function resolveOptionalExtensionCapabilities(
  registeredExtensionIds: ReadonlyArray<string>,
  migrationVerifiedExtensionIds: ReadonlyArray<string> = registeredExtensionIds,
): OptionalExtensionCapabilityStateV1 {
  const registered = new Set(registeredExtensionIds);
  const migrationVerified = new Set(migrationVerifiedExtensionIds);
  const available = (extensionId: string) =>
    registered.has(extensionId) && migrationVerified.has(extensionId);
  return Object.freeze({
    code: available(CODE_EXTENSION_ID),
    integrations: available(INTEGRATIONS_EXTENSION_ID),
    companion: available(COMPANION_EXTENSION_ID),
  });
}

export function extensionIdForCapability(
  capability: keyof OptionalExtensionCapabilityStateV1,
): string {
  switch (capability) {
    case "code":
      return CODE_EXTENSION_ID;
    case "integrations":
      return INTEGRATIONS_EXTENSION_ID;
    case "companion":
      return COMPANION_EXTENSION_ID;
  }
}
