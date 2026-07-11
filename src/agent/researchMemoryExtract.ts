import type { MissionEvidence } from "./missionLedger";

export interface ResearchMemoryExtraction {
  topic: string;
  text: string;
  keywords: string[];
  sourcePaths: string[];
  sourceUrls: string[];
}

const MAX_TOPIC_CHARS = 80;
const MAX_FINDING_CHARS = 900;
const MAX_SOURCES = 8;
const MAX_KEYWORDS = 8;

const KEYWORD_STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "on", "in", "to", "for", "with", "about",
  "from", "into", "onto", "this", "that", "these", "those", "my", "your",
  "our", "their", "its", "his", "her", "me", "you", "we", "they", "it",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "can", "could", "should", "would", "will", "shall", "may", "might",
  "write", "please", "give", "make", "find", "search", "current", "latest",
  "note", "notes", "page", "then", "than", "also", "some", "more", "most",
  "word", "words", "essay", "summary", "report", "brief",
]);

/**
 * Deterministic post-run memory extraction: web-grounded missions that passed
 * acceptance persist their findings and sources as durable research memory
 * without an extra model call. Vault-only reads and chat answers are skipped
 * so personal Q&A does not pollute the research memory folder.
 */
export function buildResearchMemoryExtraction({
  mission,
  finalOutput,
  evidence,
}: {
  mission: string;
  finalOutput: string;
  evidence: MissionEvidence[];
}): ResearchMemoryExtraction | null {
  const trimmedMission = mission.replace(/\s+/g, " ").trim();
  const trimmedFindings = finalOutput.replace(/\r\n/g, "\n").trim();
  if (!trimmedMission || !trimmedFindings) {
    return null;
  }

  const webSources = dedupe(
    evidence
      .filter((item) => item.kind === "web_source" || Boolean(item.url))
      .map((item) => item.url ?? "")
      .filter(Boolean),
  ).slice(0, MAX_SOURCES);
  if (webSources.length === 0) {
    return null;
  }

  const vaultSources = dedupe(
    evidence
      .filter((item) => item.kind === "vault_note" && Boolean(item.path))
      .map((item) => item.path ?? "")
      .filter(Boolean),
  ).slice(0, MAX_SOURCES);

  const findings =
    trimmedFindings.length <= MAX_FINDING_CHARS
      ? trimmedFindings
      : `${trimmedFindings.slice(0, MAX_FINDING_CHARS)}...`;

  const text = [
    `Mission: ${trimmedMission}`,
    "",
    "Findings:",
    findings,
    "",
    "Sources:",
    ...webSources.map((url) => `- ${url}`),
    ...vaultSources.map((path) => `- [[${path}]]`),
  ].join("\n");

  return {
    topic: buildTopic(trimmedMission),
    text,
    keywords: buildKeywords(trimmedMission),
    sourcePaths: vaultSources,
    sourceUrls: webSources,
  };
}

function buildTopic(mission: string): string {
  const compact = mission
    .replace(/[#*_`[\]|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= MAX_TOPIC_CHARS) {
    return compact;
  }
  const cut = compact.slice(0, MAX_TOPIC_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : MAX_TOPIC_CHARS)}...`;
}

function buildKeywords(mission: string): string[] {
  const words = mission
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(
      (word) =>
        word.length >= 3 && !KEYWORD_STOPWORDS.has(word) && !/^\d+$/.test(word),
    );
  return dedupe(words).slice(0, MAX_KEYWORDS);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
