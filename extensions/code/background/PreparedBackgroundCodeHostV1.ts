import type {
  ConsumedBackgroundCodeGrantV1,
  PreparedBackgroundCodeActionV1,
} from "../../../packages/core-api/src/preparedBackgroundCodeActionV1";
import type { PreparedBackgroundCodePackageIdentityV1 } from "../../../packages/core-api/src/preparedBackgroundCodePackageIdentityV1";
import type { PreparedActionV1 } from "../../../packages/core-api/src/contracts";
import type {
  BackgroundAuthorizationV1,
} from "../../../packages/headless-runtime/src/backgroundContinuation";
import type { MissionGraphV3 } from "../../../packages/headless-runtime/src/missionGraphV3";
import type { RepositoryProfileV2 } from "../repositories";
import type {
  SandboxCapabilityStatusV2,
  SandboxProviderConfigV2,
  SandboxProviderKindV2,
} from "../sandbox";
import type {
  ArtifactHashReadbackV1,
  CodeRepairCheckpointV1,
} from "../repair";
import {
  createPreparedBackgroundCodeExecutionPlanV1,
  PreparedBackgroundCodeExecutionPlanStoreV1,
  type PreparedBackgroundCodeExecutionPlanV1,
  type PreparedSandboxValidationStepV1,
} from "./PreparedBackgroundCodeExecutionPlanV1";
import {
  createPreparedBackgroundCodePackageV1,
  preparedBackgroundCodePackageIdentityV1,
  PreparedBackgroundCodePackageStoreV1,
  type PreparedBackgroundCodePackagePersistenceReceiptV1,
  type PreparedBackgroundCodePackageV1,
} from "./PreparedBackgroundCodePackageStoreV1";

export interface PrepareBackgroundCodePackageInputV1 {
  jobId: string;
  backgroundAuthorizationFingerprint: string;
  handoff: PreparedBackgroundCodeActionV1;
  checkpoint: CodeRepairCheckpointV1;
  repositoryProfile: RepositoryProfileV2;
  sandboxCapabilityStatus: SandboxCapabilityStatusV2;
  sandboxProviders: SandboxProviderConfigV2[];
  targetedValidation: PreparedSandboxValidationStepV1;
  fullValidation: PreparedSandboxValidationStepV1;
  approvedArtifacts: ArtifactHashReadbackV1[];
  sandboxProvider: SandboxProviderKindV2;
  sandboxBoundaryFingerprint: string;
}

export interface PreparedBackgroundCodePackageResultV1 {
  executionPlan: PreparedBackgroundCodeExecutionPlanV1;
  package: PreparedBackgroundCodePackageV1;
  packageIdentity: PreparedBackgroundCodePackageIdentityV1;
  packagePersistenceReceipt: PreparedBackgroundCodePackagePersistenceReceiptV1;
}

export interface PrepareBackgroundValidationCommitApprovalInputV1 {
  repairCheckpointId: string;
  runId: string;
  toolCallId: string;
}

export type PrepareBackgroundValidationCommitApprovalResultV1 =
  | { status: "ready"; preparedAction: PreparedActionV1 }
  | {
      status: "blocked";
      code: string;
      message: string;
      requiredAction: string | null;
    };

export interface SealBackgroundValidationCommitPackageInputV1 {
  graph: MissionGraphV3;
  authorization: BackgroundAuthorizationV1;
  preparedAction: PreparedActionV1;
  authority: ConsumedBackgroundCodeGrantV1;
}

export type SealBackgroundValidationCommitPackageResultV1 =
  | {
      status: "ready";
      handoff: PreparedBackgroundCodeActionV1;
      packageIdentity: PreparedBackgroundCodePackageIdentityV1;
      packagePersistenceReceipt: PreparedBackgroundCodePackagePersistenceReceiptV1;
    }
  | {
      status: "blocked";
      code: string;
      message: string;
      requiredAction: string | null;
    };

/**
 * Foreground Code-extension seam. It persists and reads back the local-only
 * executable plan before exposing either remote-safe identity to core.
 */
export class PreparedBackgroundCodeHostV1 {
  private readonly plans: PreparedBackgroundCodeExecutionPlanStoreV1;
  private readonly packages: PreparedBackgroundCodePackageStoreV1;

  constructor(input: { applicationDataRoot: string; now?: () => Date }) {
    this.plans = new PreparedBackgroundCodeExecutionPlanStoreV1(
      input.applicationDataRoot,
    );
    this.packages = new PreparedBackgroundCodePackageStoreV1({
      applicationDataRoot: input.applicationDataRoot,
      now: input.now,
    });
  }

  async prepare(
    input: PrepareBackgroundCodePackageInputV1,
  ): Promise<PreparedBackgroundCodePackageResultV1> {
    const plan = createPreparedBackgroundCodeExecutionPlanV1({
      jobId: input.jobId,
      handoffFingerprint: input.handoff.fingerprint,
      checkpoint: input.checkpoint,
      repositoryProfile: input.repositoryProfile,
      sandboxCapabilityStatus: input.sandboxCapabilityStatus,
      sandboxProviders: input.sandboxProviders,
      targetedValidation: input.targetedValidation,
      fullValidation: input.fullValidation,
      approvedArtifacts: input.approvedArtifacts,
      preparedAt: input.handoff.preparedAt,
      expiresAt: input.handoff.expiresAt,
    });
    const planReadback = await this.plans.persist(plan);
    if (planReadback.fingerprint !== plan.fingerprint) {
      throw new Error("Prepared Code execution plan failed fingerprint readback.");
    }
    const preparedPackage = createPreparedBackgroundCodePackageV1({
      jobId: input.jobId,
      backgroundAuthorizationFingerprint:
        input.backgroundAuthorizationFingerprint,
      executionPlanFingerprint: planReadback.fingerprint,
      repairCheckpointStage: input.checkpoint.stage,
      sandboxProvider: input.sandboxProvider,
      sandboxBoundaryFingerprint: input.sandboxBoundaryFingerprint,
      handoff: input.handoff,
    });
    const persisted = await this.packages.persist(preparedPackage);
    if (
      persisted.package.fingerprint !== preparedPackage.fingerprint ||
      persisted.receipt.readbackVerified !== true
    ) {
      throw new Error("Prepared Code package failed exact persistence readback.");
    }
    return {
      executionPlan: planReadback,
      package: persisted.package,
      packageIdentity: preparedBackgroundCodePackageIdentityV1(
        persisted.package,
      ),
      packagePersistenceReceipt: persisted.receipt,
    };
  }
}
