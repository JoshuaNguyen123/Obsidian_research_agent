import { canonicalJson, type PreparedAction } from "./actions";

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  action: string;
  reason: string;
  policyTags: string[];
  expiresAtMs: number;
  preparedAction?: PreparedAction;
  payloadFingerprint?: string;
  confirmationIndex?: number;
  requiredConfirmations?: 1 | 2;
}

export type ApprovalDecision = "approved" | "denied" | "expired" | "aborted";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private sequence = 0;

  async request(
    request: Omit<ApprovalRequest, "id" | "expiresAtMs">,
    options: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
      onRequest?: (request: ApprovalRequest) => void | Promise<void>;
    } = {},
  ): Promise<ApprovalDecision> {
    validateRequestBinding(request);
    const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
    const id = `approval-${request.runId}-${++this.sequence}`;
    const approvalRequest = cloneApprovalRequest({
      ...normalizeRequest(request),
      id,
      expiresAtMs: Date.now() + timeoutMs,
    });

    let settleDecision: (decision: ApprovalDecision) => void = () => undefined;
    const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
      settleDecision = (decision: ApprovalDecision) => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        if (pending.abortHandler) {
          options.abortSignal?.removeEventListener("abort", pending.abortHandler);
        }
        this.pending.delete(id);
        resolve(decision);
      };

      const timeout = setTimeout(() => settleDecision("expired"), timeoutMs);
      const pending: PendingApproval = {
        request: approvalRequest,
        resolve: settleDecision,
        timeout,
      };
      if (options.abortSignal) {
        pending.abortHandler = () => settleDecision("aborted");
        options.abortSignal.addEventListener("abort", pending.abortHandler, {
          once: true,
        });
      }
      this.pending.set(id, pending);
      if (options.abortSignal?.aborted) {
        settleDecision("aborted");
      }
    });

    if (!options.abortSignal?.aborted) {
      try {
        // Async listeners are a durability barrier: an instant UI approval
        // cannot authorize the tool until pending approval state is persisted.
        await options.onRequest?.(cloneApprovalRequest(approvalRequest));
      } catch (error) {
        // A UI/persistence listener failure is not a user denial. Settle the
        // pending request before surfacing the infrastructure error so the
        // graph can record an aborted approval without leaking a live timer.
        settleDecision("aborted");
        await decisionPromise;
        throw error;
      }
    }

    return decisionPromise;
  }

  resolve(id: string, decision: "approved" | "denied"): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      return false;
    }
    pending.resolve(decision);
    return true;
  }

  getPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((item) =>
      cloneApprovalRequest(item.request),
    );
  }
}

function validateRequestBinding(
  request: Omit<ApprovalRequest, "id" | "expiresAtMs">,
): void {
  if (!request.runId.trim() || !request.toolName.trim()) {
    throw new TypeError("Approval request run and tool identities are required.");
  }
  if (request.preparedAction) {
    if (
      request.preparedAction.runId !== request.runId ||
      request.preparedAction.toolName !== request.toolName
    ) {
      throw new TypeError(
        "Approval request identity does not match the prepared action.",
      );
    }
    if (
      request.payloadFingerprint !== undefined &&
      request.payloadFingerprint !== request.preparedAction.payloadFingerprint
    ) {
      throw new TypeError(
        "Approval request fingerprint does not match the prepared action.",
      );
    }
  }
  const required = request.requiredConfirmations ?? 1;
  const index = request.confirmationIndex ?? 1;
  if ((required !== 1 && required !== 2) || index < 1 || index > required) {
    throw new RangeError("Approval confirmation index is outside its required range.");
  }
}

function normalizeRequest(
  request: Omit<ApprovalRequest, "id" | "expiresAtMs">,
): Omit<ApprovalRequest, "id" | "expiresAtMs"> {
  const normalized: Omit<ApprovalRequest, "id" | "expiresAtMs"> = {
    ...request,
    policyTags: [...request.policyTags],
  };
  if (request.preparedAction) {
    normalized.preparedAction = cloneJson(request.preparedAction);
    normalized.payloadFingerprint = request.preparedAction.payloadFingerprint;
    normalized.requiredConfirmations = request.requiredConfirmations ?? 1;
    normalized.confirmationIndex = request.confirmationIndex ?? 1;
  }
  return normalized;
}

function cloneApprovalRequest(request: ApprovalRequest): ApprovalRequest {
  return cloneJson(request);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
