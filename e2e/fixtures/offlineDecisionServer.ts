import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * A loopback stand-in for OpenRouter's alpha decisions endpoint, for the
 * installed plugin's Jev journeys. The plugin reaches it through its own
 * production transport by `decisionEndpointOverride` (loopback only). It
 * answers in the endpoint's shape — `{id, model, answers, usage}` — and keeps
 * every request it received, so a journey can assert what was asked.
 *
 * Mission assessments (questions `route`, `web_evidence`, …) and claim checks
 * (questions `claim_1`…`claim_8`) are told apart by their question names.
 */
export interface OfflineDecisionScriptV1 {
  /** Mission assessment answers, or "abstain" for no clear answer anywhere. */
  mission: "abstain" | "web_evidence" | "outage";
  /** Verdict for one claim's text, or "outage" for a 503. */
  claim: (claimText: string) => { verdict: "supported" | "contradicted" | "insufficient"; probability: number } | "outage";
}

export interface OfflineDecisionServerV1 {
  readonly url: string;
  readonly requests: Array<{ kind: "mission" | "claims"; authorized: boolean; body: Record<string, any> }>;
  script(next: OfflineDecisionScriptV1): void;
  close(): Promise<void>;
}

export const OFFLINE_DECISION_TOKEN_V1 = "offline-e2e-decision-token";

export async function startOfflineDecisionServerV1(port: number): Promise<OfflineDecisionServerV1> {
  let current: OfflineDecisionScriptV1 = {
    mission: "abstain",
    claim: () => ({ verdict: "supported", probability: 0.95 }),
  };
  const requests: OfflineDecisionServerV1["requests"] = [];
  const server: Server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || !request.url?.startsWith("/api/alpha/decisions")) {
      send(404, { error: "not found" });
      return;
    }
    const body = JSON.parse(await readBody(request)) as Record<string, any>;
    const questions = Object.keys(body.questions ?? {});
    const kind = questions.some((name) => /^claim_\d+$/u.test(name)) ? "claims" : "mission";
    const authorized = request.headers.authorization === `Bearer ${OFFLINE_DECISION_TOKEN_V1}`;
    requests.push({ kind, authorized, body });
    if (!authorized) {
      send(401, { error: "unauthorized" });
      return;
    }
    if (kind === "mission") {
      if (current.mission === "outage") {
        send(503, { error: "unavailable" });
        return;
      }
      send(200, {
        id: `gen-mission-${requests.length}`,
        model: "typesafe/jev-1.13",
        answers:
          current.mission === "web_evidence"
            ? {
                web_evidence: { type: "noul", noul: 0.97 },
                vault_evidence: { type: "noul", noul: 0.03 },
              }
            : {},
        usage: { input_tokens: 420, output_tokens: 14, cost: 0.00002 },
      });
      return;
    }
    const claims: Array<{ key: string; text: string }> = body.state?.claims ?? [];
    const answers: Record<string, unknown> = {};
    for (const claim of claims) {
      const judged = current.claim(claim.text);
      if (judged === "outage") {
        send(503, { error: "unavailable" });
        return;
      }
      const rest = (1 - judged.probability) / 2;
      answers[claim.key] = {
        type: "choice",
        choice: judged.verdict,
        confidence: judged.probability,
        probabilities: {
          supported: judged.verdict === "supported" ? judged.probability : rest,
          contradicted: judged.verdict === "contradicted" ? judged.probability : rest,
          insufficient: judged.verdict === "insufficient" ? judged.probability : rest,
        },
      };
    }
    send(200, {
      id: `gen-claims-${requests.length}`,
      model: "typesafe/jev-1.13",
      answers,
      usage: { input_tokens: 900, output_tokens: 24, cost: 0.00004 },
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}/api/alpha/decisions`,
    requests,
    script(next) {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
