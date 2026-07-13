import {
  AGENTIC_RESEARCHER_CORE_API_MAJOR,
  AGENTIC_RESEARCHER_CORE_API_MINOR,
  type ExpectedExtensionV1,
} from "../../packages/core-api/src";

export const EXPECTED_AGENTIC_RESEARCHER_EXTENSIONS: ReadonlyArray<ExpectedExtensionV1> =
  Object.freeze([
    Object.freeze({
      id: "agentic-researcher-code",
      displayName: "Agentic Researcher Code",
      apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
      minimumApiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
      optional: true,
    }),
    Object.freeze({
      id: "agentic-researcher-integrations",
      displayName: "Agentic Researcher Integrations",
      apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
      minimumApiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
      optional: true,
    }),
    Object.freeze({
      id: "agentic-researcher-companion",
      displayName: "Agentic Researcher Companion",
      apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
      minimumApiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
      optional: true,
    }),
  ]);
