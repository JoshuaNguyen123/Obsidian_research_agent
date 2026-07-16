export interface PromptScenario {
  name: string;
  prompt: string;
  mode: "mock" | "real" | "both";
  timeoutMs: number;
  expectNoteWrite: boolean;
  expectReceipt: boolean;
  expectTools?: string[];
  expectArtifact?: ".canvas" | ".svg";
  requiredTerms: string[];
  requiredNewTextTerms?: string[];
  minNewWords?: number;
}

export const generatedOutputPromptScenarios: PromptScenario[] = [
  {
    name: "revolutionary-war-100",
    prompt: "Generate me a 100 word essay on the history of the revolutionary war.",
    mode: "both",
    timeoutMs: 180_000,
    expectNoteWrite: true,
    expectReceipt: true,
    requiredTerms: ["Revolutionary", "war"],
  },
  {
    name: "gilgamesh-500",
    prompt: "Write me a 500 word essay on the epic of Gilgamesh.",
    mode: "both",
    timeoutMs: 900_000,
    expectNoteWrite: true,
    expectReceipt: true,
    requiredTerms: ["Gilgamesh", "Enkidu"],
    requiredNewTextTerms: ["Gilgamesh", "Enkidu", "mortality"],
    minNewWords: 350,
  },
  {
    name: "grapes-1000",
    prompt: "Generate me a 1000 word essay on Grapes of Wrath.",
    mode: "both",
    timeoutMs: 600_000,
    expectNoteWrite: true,
    expectReceipt: true,
    requiredTerms: ["Grapes", "Wrath"],
  },
  {
    name: "grapes-stream-title",
    prompt: "Write me a short essay on Grapes of Wrath and stream it to the page.",
    mode: "mock",
    timeoutMs: 240_000,
    expectNoteWrite: true,
    expectReceipt: true,
    requiredTerms: ["Grapes", "Wrath"],
    requiredNewTextTerms: ["Dust Bowl"],
  },
  {
    name: "grapes-cited",
    prompt:
      "Write me a 300 word argumentative essay on Grapes of Wrath. Use text level quotation and citations.",
    mode: "real",
    timeoutMs: 600_000,
    expectNoteWrite: true,
    expectReceipt: true,
    expectTools: ["web_search", "web_fetch"],
    requiredTerms: ["Grapes", "Wrath"],
  },
  {
    name: "cast-iron-steak",
    prompt: "Tell me about how to cook the best steak, with a cast iron.",
    mode: "both",
    timeoutMs: 180_000,
    expectNoteWrite: true,
    expectReceipt: true,
    requiredTerms: ["steak", "cast iron"],
  },
  {
    name: "diagonalization",
    prompt:
      "Walk me through how diagonalization works in Linear Algebra with grounded examples.",
    mode: "mock",
    timeoutMs: 240_000,
    expectNoteWrite: true,
    expectReceipt: true,
    requiredTerms: ["diagonalization", "Linear Algebra"],
  },
  {
    name: "three-block-diagram",
    prompt:
      "Draw me a simple 3 block diagram that shows house, transportation, and workplace.",
    mode: "mock",
    timeoutMs: 240_000,
    expectNoteWrite: false,
    expectReceipt: true,
    expectArtifact: ".canvas",
    requiredTerms: ["house", "transportation", "workplace"],
  },
];
