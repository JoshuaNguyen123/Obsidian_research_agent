export const AGENT_GIT_COMMIT_NAME_V1 = "Agentic Researcher" as const;
export const AGENT_GIT_COMMIT_EMAIL_V1 =
  "agentic-researcher@example.invalid" as const;

/**
 * Commits created before the attribution-integrity hardening used a local-only
 * address. It is safe to publish but is no longer emitted for new commits.
 */
export const LEGACY_AGENT_GIT_COMMIT_EMAIL_V1 =
  "agentic-researcher@localhost" as const;

export interface AgentGitCommitIdentityV1 {
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

export function agentGitCommitIdentityEnvironmentV1(): Readonly<
  Record<string, string>
> {
  return Object.freeze({
    GIT_AUTHOR_NAME: AGENT_GIT_COMMIT_NAME_V1,
    GIT_AUTHOR_EMAIL: AGENT_GIT_COMMIT_EMAIL_V1,
    GIT_COMMITTER_NAME: AGENT_GIT_COMMIT_NAME_V1,
    GIT_COMMITTER_EMAIL: AGENT_GIT_COMMIT_EMAIL_V1,
  });
}

export function isAgentGitCommitIdentityV1(
  identity: AgentGitCommitIdentityV1,
  options: { allowLegacyLocalhost?: boolean } = {},
): boolean {
  const allowedEmails = new Set<string>([AGENT_GIT_COMMIT_EMAIL_V1]);
  if (options.allowLegacyLocalhost === true) {
    allowedEmails.add(LEGACY_AGENT_GIT_COMMIT_EMAIL_V1);
  }
  return (
    identity.authorName === AGENT_GIT_COMMIT_NAME_V1 &&
    identity.committerName === AGENT_GIT_COMMIT_NAME_V1 &&
    identity.authorEmail === identity.committerEmail &&
    allowedEmails.has(identity.authorEmail)
  );
}
