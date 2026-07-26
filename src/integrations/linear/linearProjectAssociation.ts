/**
 * Host-owned Linear project association policy.
 *
 * Default for mission-shaped Linear work: reuse an associated project when one
 * exists; otherwise create a project and place issues there.
 * Plain / general issue creation stays team-scoped without inventing a project.
 */

export type LinearProjectAssociationCandidate = {
  id: string;
  name: string;
  teamIds?: readonly string[];
};

export type LinearProjectAssociationDecision =
  | {
      mode: "team_only";
      reason: "plain_issue_intent";
    }
  | {
      mode: "use_existing";
      projectId: string;
      reason: "configured" | "associated_match" | "lineage";
      projectName?: string;
    }
  | {
      mode: "create_project";
      projectName: string;
      reason: "no_associated_project";
    };

export interface DecideLinearProjectAssociationInput {
  prompt: string;
  /** Title or short mission phrase used to match / name a project. */
  associationText: string;
  configuredProjectId?: string | null;
  /** Optional project ids already bound to this mission via host lineage. */
  lineageProjectIds?: readonly string[];
  candidates: readonly LinearProjectAssociationCandidate[];
  teamId?: string | null;
}

/**
 * True when the user explicitly wants a general / standalone Linear issue
 * (no mission project container). Default association still finds or creates
 * a project for ordinary issue and research publishing work.
 */
export function hasPlainLinearIssueOnlyIntent(prompt: string): boolean {
  const text = typeof prompt === "string" ? prompt : "";
  if (!text.trim() || !mentionsLinearIssueCreation(text)) {
    return false;
  }

  const withoutProject =
    /\b(?:without|no|skip|exclude)\b[^.\n]{0,60}\b(?:a\s+)?project\b/iu.test(
      text,
    );
  const generalIssueLanguage =
    /\b(?:general|standalone|plain|one[- ]off|ad[- ]hoc)\b[\s\S]{0,48}\b(?:issue|ticket)\b/iu.test(
      text,
    ) ||
    /\b(?:just|only)\s+(?:create|open|file)\b[\s\S]{0,48}\b(?:a\s+)?(?:general\s+|standalone\s+|plain\s+)?(?:issue|ticket)\b/iu.test(
      text,
    );
  if (!withoutProject && !generalIssueLanguage) {
    return false;
  }

  // "…without a project" is an explicit opt-out even if the word "project" appears.
  if (withoutProject) {
    return true;
  }

  if (
    /\b(?:project|initiative|hierarchy|mission|end[- ]to[- ]end|workstream|epic)\b/iu.test(
      text,
    ) ||
    /\b(?:publish|send|sync)\b[\s\S]{0,120}\blinear\b/iu.test(text) ||
    /\b(?:accepted\s+)?research\b[\s\S]{0,120}\blinear\b/iu.test(text)
  ) {
    return false;
  }

  return true;
}

export function decideLinearProjectAssociationPolicy(
  input: DecideLinearProjectAssociationInput,
): LinearProjectAssociationDecision {
  if (hasPlainLinearIssueOnlyIntent(input.prompt)) {
    return { mode: "team_only", reason: "plain_issue_intent" };
  }

  const teamId =
    typeof input.teamId === "string" && input.teamId.trim()
      ? input.teamId.trim()
      : null;
  const candidates = filterCandidatesForTeam(input.candidates, teamId);
  const byId = new Map(candidates.map((item) => [item.id, item]));

  for (const lineageId of input.lineageProjectIds ?? []) {
    const id = typeof lineageId === "string" ? lineageId.trim() : "";
    if (!id) continue;
    const match = byId.get(id);
    if (match) {
      return {
        mode: "use_existing",
        projectId: match.id,
        reason: "lineage",
        projectName: match.name,
      };
    }
  }

  const configured =
    typeof input.configuredProjectId === "string"
      ? input.configuredProjectId.trim()
      : "";
  if (configured) {
    const match = byId.get(configured);
    if (match) {
      return {
        mode: "use_existing",
        projectId: match.id,
        reason: "configured",
        projectName: match.name,
      };
    }
  }

  const associated = matchAssociatedLinearProject(
    candidates,
    input.associationText,
  );
  if (associated) {
    return {
      mode: "use_existing",
      projectId: associated.id,
      reason: "associated_match",
      projectName: associated.name,
    };
  }

  return {
    mode: "create_project",
    projectName: deriveLinearProjectNameFromMission(input.associationText),
    reason: "no_associated_project",
  };
}

export function matchAssociatedLinearProject(
  candidates: readonly LinearProjectAssociationCandidate[],
  associationText: string,
): LinearProjectAssociationCandidate | null {
  const needle = normalizeAssociationKey(associationText);
  if (!needle || needle.length < 3) return null;

  const needleTokens = significantTokens(needle);
  let best: { candidate: LinearProjectAssociationCandidate; score: number } | null =
    null;

  for (const candidate of candidates) {
    const haystack = normalizeAssociationKey(candidate.name);
    if (!haystack) continue;

    let score = 0;
    if (haystack === needle) {
      score = 100;
    } else if (haystack.includes(needle) || needle.includes(haystack)) {
      const shorter = Math.min(haystack.length, needle.length);
      const longer = Math.max(haystack.length, needle.length);
      score = shorter >= 8 && shorter / longer >= 0.55 ? 80 : 0;
    } else if (needleTokens.length >= 2) {
      const hayTokens = new Set(significantTokens(haystack));
      const overlap = needleTokens.filter((token) => hayTokens.has(token)).length;
      if (overlap === needleTokens.length && overlap >= 2) {
        score = 70;
      } else if (overlap >= 2 && overlap / needleTokens.length >= 0.75) {
        score = 60;
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { candidate, score };
    }
  }

  return best?.candidate ?? null;
}

export function deriveLinearProjectNameFromMission(associationText: string): string {
  const cleaned = String(associationText ?? "")
    .replace(/\s+/gu, " ")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .trim();
  const firstLine = cleaned.split(/[\r\n]+/u)[0]?.trim() ?? "";
  const withoutIssueVerb = firstLine
    .replace(
      /^(?:please\s+)?(?:create|open|file|add|publish|send|build|shape|turn)\s+(?:a\s+|an\s+|the\s+)?(?:linear\s+)?(?:issue|ticket|project|initiative)\s+(?:for|about|on|to)\s+/iu,
      "",
    )
    .replace(/^(?:please\s+)?(?:research|implement|build)\s+/iu, "")
    .trim();
  const base = (withoutIssueVerb || firstLine || "Agent mission").slice(0, 80).trim();
  return base.length >= 3 ? base : "Agent mission";
}

export function normalizeAssociationKey(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function significantTokens(normalized: string): string[] {
  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter(
      (token) =>
        ![
          "the",
          "and",
          "for",
          "with",
          "from",
          "into",
          "this",
          "that",
          "linear",
          "issue",
          "ticket",
          "project",
          "agent",
          "mission",
        ].includes(token),
    );
}

function filterCandidatesForTeam(
  candidates: readonly LinearProjectAssociationCandidate[],
  teamId: string | null,
): LinearProjectAssociationCandidate[] {
  if (!teamId) {
    return candidates.filter((item) => typeof item.id === "string" && item.id.trim());
  }
  return candidates.filter((item) => {
    if (typeof item.id !== "string" || !item.id.trim()) return false;
    const teamIds = item.teamIds ?? [];
    return teamIds.length === 0 || teamIds.includes(teamId);
  });
}

function mentionsLinearIssueCreation(text: string): boolean {
  return (
    /\b(?:create|open|file|add)\b[\s\S]{0,100}\b(?:linear\s+)?(?:issue|ticket)\b/iu.test(
      text,
    ) ||
    /\b(?:linear\s+)?(?:issue|ticket)\b[\s\S]{0,80}\b(?:create|open|file|add)\b/iu.test(
      text,
    )
  );
}
