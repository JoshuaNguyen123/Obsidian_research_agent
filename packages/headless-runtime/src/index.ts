export const HEADLESS_RUNTIME_API_VERSION = 1 as const;

export interface HeadlessRuntimeRegistration {
  apiVersion: typeof HEADLESS_RUNTIME_API_VERSION;
  runtimeId: string;
}

export * from "./missionGraphV3";
export * from "./missionGraphProjection";
export * from "./missionScheduler";
export * from "./backgroundContinuation";
export * from "./companionCredentialSession";
export * from "./companionCoordinatorClient";
export * from "./companionWorkerCoordinator";
export * from "./companionLinearQueuePoller";
export * from "./companionSafetyAttestation";
export * from "./publicResearchFetchExecutor";
export * from "./installedDomainExecutors";
export * from "./canonicalize";
export * from "./secretStoreV1";
