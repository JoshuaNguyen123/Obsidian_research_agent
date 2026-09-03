/**
 * User-shaped STEM research prompts, same contract as the live Genesis
 * mission: 1000-word research note, scholarly citations, stream onto the
 * current page, change the title.
 *
 * Topics avoid words that trip adjacent routers:
 * - no `\bcode\b` / python / module (code workflow)
 * - no `\blinear\b` (Linear issue workflow)
 * - no "distributed systems" (design-artifact noun)
 * - the live AI case uses RLHF, not "transformer architecture": that pairing
 *   is a design-noun trap. The architecture prompt is kept as a unit-only
 *   stress case.
 */
export interface DomainResearchCaseV1 {
  id: string;
  domain: "cs" | "engineering" | "physics" | "medicine" | "biology" | "ai";
  topic: string;
  /** Full Genesis-shaped prompt a user would type. */
  prompt: string;
}

export const PAGE_CLEAR_THEN_REWRITE =
  "Delete all the notes on the page, and re-write your essay from a more informative perspective.";
export const PAGE_CLEAR_FIRST = "Delete all the notes on the page first.";
export const PAGE_CLEAR_DELATE = "Delate all the notes on the page first.";

const GENESIS_SHAPE = (topic: string): string =>
  `I want you to write me a 1000 word research note on ${topic}. Cite at least 5-10 scholarly and academic sources. I want you to stream your results into this note page. Change the title as well.`;

export const DOMAIN_RESEARCH_CASES: readonly DomainResearchCaseV1[] = [
  {
    id: "cs-raft",
    domain: "cs",
    topic: "the Raft consensus algorithm",
    prompt: GENESIS_SHAPE("the Raft consensus algorithm"),
  },
  {
    id: "engineering-battery-thermal",
    domain: "engineering",
    topic: "lithium-ion battery thermal management in electric vehicles",
    prompt: GENESIS_SHAPE(
      "lithium-ion battery thermal management in electric vehicles",
    ),
  },
  {
    id: "physics-bell",
    domain: "physics",
    topic: "Bell's inequality and experimental tests of quantum entanglement",
    prompt: GENESIS_SHAPE(
      "Bell's inequality and experimental tests of quantum entanglement",
    ),
  },
  {
    id: "medicine-glp1",
    domain: "medicine",
    topic: "GLP-1 receptor agonists for type 2 diabetes and obesity",
    prompt: GENESIS_SHAPE(
      "GLP-1 receptor agonists for type 2 diabetes and obesity",
    ),
  },
  {
    id: "biology-crispr",
    domain: "biology",
    topic: "CRISPR-Cas9 genome editing and off-target effects",
    prompt: GENESIS_SHAPE(
      "CRISPR-Cas9 genome editing and off-target effects",
    ),
  },
  {
    id: "ai-rlhf",
    domain: "ai",
    topic: "reinforcement learning from human feedback",
    prompt: GENESIS_SHAPE("reinforcement learning from human feedback"),
  },
];

/** Unit-only: `architecture` is a design noun; this must stay a research note. */
export const TRANSFORMER_ARCHITECTURE_RESEARCH_PROMPT = GENESIS_SHAPE(
  "the transformer architecture and self-attention",
);

/** Shorter live-harness variant: two sources, 150 words, stream, retitle. */
export function compactDomainResearchPrompt(
  topic: string,
  marker: string,
): string {
  return (
    `Write a 150-word research note on ${topic}. ` +
    "Cite at least two scholarly and academic sources. " +
    "Stream your results into this note page. Change the title as well. " +
    `Include the exact marker ${marker} as its own final line.`
  );
}
