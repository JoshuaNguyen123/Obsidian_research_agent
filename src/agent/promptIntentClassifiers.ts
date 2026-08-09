/**
 * Prompt-intent classifiers: the deterministic regex predicates that decide
 * which tools a prompt is offered and which mission shapes it can take.
 *
 * Extracted verbatim from AgentRunner.ts, where ~100 of them lived inside a
 * 35k-line module. They are pure string->boolean/string[] functions with no
 * loop state, which made them the cleanest first tranche of the monolith
 * extraction. AgentRunner re-exports the previously-public names, so existing
 * imports keep working.
 *
 * Behavior contract: byte-identical bodies. A wording change to any regex here
 * is a routing change and belongs in its own commit with routingGoldenCorpus
 * coverage, never in a move.
 */

import {
  assertCleanLinearHumanOutputV1,
  assertLinearIssueBodyV1,
  getLinearIssueTitleProblemV1,
} from "../integrations/linear/LinearIssueFormatV1";
import { type ModelToolCall } from "../model/types";
import { hasExplicitResearchProjectHierarchyIntent } from "../tools/researchProjectHierarchyTool";
import { hasExplicitResearchPublicationIntent } from "../tools/researchPublicationTool";
import { getErrorMessage } from "../tools/validation";
import { hasCodeDeliverableIntent } from "./codeDeliverableIntent";
import {
  hasDesignIntent as hasSharedDesignIntent,
  hasExplicitCanvasDestinationIntent,
  hasReviseDesignIntent,
} from "./codeDesignIntent";
import { isCurrentNoteReplaceResetPrompt } from "./currentNoteResetPolicy";
import { isCurrentNoteEditOrganizeIntent, isNamedSectionEditIntent, isWholeNoteEditIntent } from "./editOrganizeIntent";
import { hasExplicitNoWebIntent, hasExplicitPublicWebSignal, hasPrimaryTextCitationIntent } from "./evidenceIntent";
import { analyzeGeneratedOutputPrompt } from "./generatedOutputPolicy";
import { detectLinearIntent } from "./linearIntent";
import { hasMissionResumeIntent } from "./missionResume";
import { extractExplicitNewWorkspaceFilePaths, extractMarkdownPathMentions, hasExplicitCurrentNoteMutationIntent } from "./missionScope";
import { isMarkdownTitleContentIntent, isTitleOnlyIntent, isVisibleTitleRenameIntent } from "./titleIntent";

export function isPromptOnCurrentPageIntent(prompt: string): boolean {
  return (
    /\b(read|check|extract|use|answer|run|execute|follow|refer)\b[\s\S]{0,100}\b(prompt|instruction|question|task|request)\b[\s\S]{0,100}\b(?:on|from|in|as)\s+(?:the\s+)?(?:page|note|document|notepage)\b/i.test(
      prompt,
    ) ||
    /\b(prompt|instruction|question|task|request)\b[\s\S]{0,100}\b(?:on|from|in)\s+(?:the\s+)?(?:page|note|document|notepage)\b/i.test(
      prompt,
    ) ||
    /\b(read|check|extract|use|answer|run|execute|follow|refer)\b[\s\S]{0,120}\bnotes?\b[\s\S]{0,120}\b(?:notepage|page|note|document)\b[\s\S]{0,80}\bas\s+(?:the\s+)?prompt\b/i.test(
      prompt,
    )
  );
}

export function isRecentAssistantWritebackFollowup(prompt: string): boolean {
  return /\b(write|copy|save|append|add|insert|paste|put)\b[\s\S]{0,100}\b(this|that|the|your|previous|prior|last|above)\s+(essay|answer|response|reply|summary|analysis|content|text|draft|paragraph|article|report)\b[\s\S]{0,100}\b(?:on|onto|to|into|in)\s+(?:the\s+)?(?:page|note|document|file|markdown)\b|\b(?:on|onto|to|into|in)\s+(?:the\s+)?(?:page|note|document|file|markdown)\b[\s\S]{0,100}\b(write|copy|save|append|add|insert|paste|put)\b[\s\S]{0,100}\b(this|that|the|your|previous|prior|last|above)\s+(essay|answer|response|reply|summary|analysis|content|text|draft|paragraph|article|report)\b/i.test(
    prompt,
  );
}

export function hasPriorAssistantResponseWritebackIntent(prompt: string): boolean {
  return /\bmost recent assistant response\b[\s\S]{0,120}\bcurrent Obsidian note\b/i.test(
    prompt,
  ) || isRecentAssistantWritebackFollowup(prompt);
}

export function hasVaultContextQuestionIntent(prompt: string): boolean {
  return /\b(what\s+(did|do)\s+you\s+(learn|know|remember)\s+about\s+me|what\s+have\s+i\s+told\s+you|what\s+do\s+my\s+notes\s+say|based\s+on\s+my\s+notes|in\s+my\s+notes|across\s+my\s+notes|search\s+(my\s+)?notes|find\s+(notes?|details?|mentions?|references?)|where\s+did\s+i\s+mention|summari[sz]e\s+what\s+i\s+(know|have|wrote)|look\s+through\s+(my\s+)?vault|check\s+(my\s+)?folders?)\b/i.test(
    prompt,
  ) || hasFolderContentQuestionIntent(prompt) || hasGraphConnectionIntent(prompt);
}

export function hasExplicitWritePersistenceIntent(prompt: string): boolean {
  return /\b(append|save|write|update|add|insert|copy|paste|put|record|persist|create|make|replace|rewrite|edit|revise|rename|move|delete|remove|trash)\b[\s\S]{0,100}\b(note|file|markdown|vault|folder|directory|path|page|document)\b|\b(note|file|markdown|vault|folder|directory|path|page|document)\b[\s\S]{0,100}\b(append|save|write|update|add|insert|copy|paste|put|record|persist|create|make|replace|rewrite|edit|revise|rename|move|delete|remove|trash)\b|\.md\b/i.test(
    prompt,
  );
}

export function hasChatOnlyResponseIntent(prompt: string): boolean {
  return /\b(chat\s+only|only\s+in\s+chat|answer\s+in\s+chat|respond\s+in\s+chat|do\s+not\s+(?:write|append|save)\s+(?:to|in|into)\s+(?:the\s+)?(?:note|page|document|file))\b/i.test(
    prompt,
  );
}

export function hasWordCountIntent(prompt: string): boolean {
  return /\b(count_words|word\s*count|count\s+(?:the\s+)?words?|how\s+many\s+words?|length\s+check|verify\s+(?:the\s+)?(?:word\s+)?length)\b/i.test(
    prompt,
  );
}

export function hasGraphConnectionIntent(prompt: string): boolean {
  const intentText = prompt.replace(
    /\bpreserve\b[^.\n]{0,100}\b(?:note\s+)?backlinks?\b/giu,
    " ",
  );
  return /\b(graph|backlinks?|outgoing\s+links?|incoming\s+links?|related\s+notes?|semantic(?:ally)?\s+(?:related|connected)|connections?|connected|link(?:ed)?\s+notes?|note\s+relationships?|references?)\b/i.test(
    intentText,
  ) && /\b(note|notes|file|files|vault|current|this|active|markdown)\b/i.test(intentText);
}

export function hasGraphLinkWriteIntent(prompt: string): boolean {
  return /\b(connect|link|add\s+(?:wiki\s+)?links?|insert\s+(?:wiki\s+)?links?|create\s+(?:wiki\s+)?links?)\b[\s\S]{0,100}\b(note|notes|current|this|active|markdown|file)\b|\b(note|notes|current|this|active|markdown|file)\b[\s\S]{0,100}\b(connect|link|add\s+(?:wiki\s+)?links?|insert\s+(?:wiki\s+)?links?|create\s+(?:wiki\s+)?links?)\b/i.test(
    prompt,
  );
}

export function hasVaultIndexIntent(prompt: string): boolean {
  return /\b(index|map|overview|inventory|catalog|where\s+are|what\s+(notes|files|documents)|locate|find)\b[\s\S]{0,120}\b(vault|notes?|files?|documents?|folders?|markdown|notebook)\b|\b(vault|notes?|files?|documents?|folders?|markdown|notebook)\b[\s\S]{0,120}\b(index|map|overview|inventory|catalog|where|locate|find)\b/i.test(
    prompt,
  );
}

/** Tabular-analysis prompts: dataset files or explicit data-analysis asks. */
export function hasDatasetAnalysisIntent(prompt: string): boolean {
  return /\b(dataset|\w+\.(?:csv|tsv|ndjson)\b|data\s+analysis|analy[sz]e\s+(?:the\s+|my\s+)?data|column\s+statistics|histogram|scatter\s*plot)\b/i.test(
    prompt,
  );
}

/**
 * Bibliographic-workflow prompts: DOIs, arXiv, BibTeX, bibliography building,
 * or explicit citation resolution/verification. Deliberately NOT bare
 * "cite/cited/citations" — ordinary "append a cited summary" prompts must keep
 * their compact tool schema; inline citing needs no bibliographic tools.
 */
export function hasCitationWorkIntent(prompt: string): boolean {
  return /\b(doi\b|arxiv|bibtex|bibliograph\w*|reference\s+list|literature\s+(?:review|search)|(?:resolve|verify|check|look\s*up)\s+(?:the\s+|this\s+|these\s+)?citations?)\b|10\.\d{4,9}\//i.test(
    prompt,
  );
}

export function hasOpenWebSourceIntent(prompt: string): boolean {
  return /\b(open|view|show|launch)\b[\s\S]{0,120}\b(source|sources|link|url|web|browser|reference|citation|page)\b|\b(source|sources|link|url|web\s+page|reference|citation|page)\b[\s\S]{0,120}\b(open|view|show|launch)\b/i.test(
    prompt,
  );
}

export function hasCodeExecutionIntent(prompt: string): boolean {
  return (
    hasStandaloneCodeExecutionIntent(prompt) ||
    hasRepositoryCodeMutationIntent(prompt) ||
    hasCodeDeliverableIntent(prompt)
  );
}

export function hasStandaloneCodeExecutionIntent(prompt: string): boolean {
  return /\b(run|execute|eval|evaluate|test|compile)\b[\s\S]{0,120}\b(code|script|program|snippet|python|javascript|typescript|html|css|c\+\+|cpp|c\s+code)\b|\b(code|script|program|snippet|python|javascript|typescript|html|css|c\+\+|cpp|c\s+code)\b[\s\S]{0,120}\b(run|execute|eval|evaluate|test|compile)\b/i.test(
    prompt,
  );
}

export function hasPreparedBackgroundCodeValidationCommitIntent(
  prompt: string,
): boolean {
  if (
    /\b(?:do\s+not|don't|never)\s+(?:invoke|use|run|execute|dispatch|continue)\b/i.test(
      prompt,
    )
  ) {
    return false;
  }
  const exactToolAction =
    /\b(?:invoke|use|run|execute|dispatch)\s+(?:only\s+)?code_validate_commit_prepared\b/i.test(
      prompt,
    );
  const explicitBackgroundAction =
    /\b(?:continue|dispatch|run|execute|perform|start|invoke|use)\b[\s\S]{0,200}\b(?:background|companion|headless)\b|\b(?:background|companion|headless)\b[\s\S]{0,200}\b(?:continue|dispatch|run|execute|perform|start|invoke|use)\b/i.test(
      prompt,
    );
  const trustedTaskMarker =
    exactToolAction ||
    /\brepairCheckpointId\b|\brepairRequestId\b|\btrusted\s+workspace\b|\bcontinue\s+run\s+[A-Za-z0-9._:-]+\b|\bexact\s+prepared\s+code\s+validation\s+commit\b/i.test(
      prompt,
    );
  return (
    trustedTaskMarker &&
    explicitBackgroundAction &&
    /\bcode\b/i.test(prompt) &&
    /\b(?:validate|validation)\b/i.test(prompt) &&
    /\bcommit\b/i.test(prompt)
  );
}

export function hasRepositoryCodeMutationIntent(prompt: string): boolean {
  if (
    !/\b(repository|repo|codebase|worktree|code\s+workspace|project\s+folder)\b/i.test(
      prompt,
    )
  ) {
    return false;
  }
  return prompt
    .split(/(?:[.!?;\r\n]+|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      if (
        /(?:\bdo\s+not\b|\bdon't\b|\bnever\b|\bwithout\b)[\s\S]{0,80}\b(repository|repo|codebase|worktree|code\s+workspace|project\s+folder|code)\b/iu.test(
          clause,
        )
      ) {
        return false;
      }
      return /\b(repository|repo|codebase|worktree|code\s+workspace|project\s+folder)\b[\s\S]{0,180}\b(implement|fix|repair|patch|refactor|edit|change|create|add|remove|rename|move|copy|validate|test|build|commit)\b|\b(implement|fix|repair|patch|refactor|edit|change|create|add|remove|rename|move|copy|validate|test|build|commit)\b[\s\S]{0,180}\b(repository|repo|codebase|worktree|code\s+workspace|project\s+folder)\b/i.test(
        clause,
      );
    });
}

export function hasRepositoryCodeEditIntent(prompt: string): boolean {
  return hasRepositoryCodeMutationIntent(prompt) &&
    /\b(implement|fix|repair|patch|refactor|edit|change|create|add|remove|rename|move|copy)\b/i.test(
      prompt,
    );
}

export function hasCodeWorkspaceReadIntent(prompt: string): boolean {
  return /\b(read|inspect|search|list|find|understand|analy[sz]e|review|explain|summari[sz]e|traverse)\b[\s\S]{0,180}\b(repository|repo|codebase|worktree|code\s+workspace|project\s+folder)\b|\b(repository|repo|codebase|worktree|code\s+workspace|project\s+folder)\b[\s\S]{0,180}\b(read|inspect|search|list|find|understand|analy[sz]e|review|explain|summari[sz]e|traverse)\b/i.test(
    prompt,
  );
}

export function hasKnownHostDirectoryExportIntent(prompt: string): boolean {
  if (hasExplicitNoHostDirectoryExportIntent(prompt)) {
    return false;
  }
  // The verb list must cover the ordinary ways a user names a destination.
  // "generate a python snake game on my desktop" planned the whole authoring
  // ladder but no export, so the work never reached the folder they named.
  return /\b(?:put|place|save|write|create|copy|export|deliver|generate|make|build)\b[\s\S]{0,160}\b(?:desktop|documents?(?:\s+folder)?|downloads?(?:\s+folder)?)\b|\b(?:desktop|documents?(?:\s+folder)?|downloads?(?:\s+folder)?)\b[\s\S]{0,160}\b(?:put|place|save|write|create|copy|export|deliver|generate|make|build)\b/iu.test(
    prompt,
  );
}

/**
 * An explicit sandbox-only instruction is a hard negative delivery boundary.
 * It wins over the ordinary standalone-code fallback that otherwise exports a
 * completed project to a host directory.
 */
export function hasExplicitNoHostDirectoryExportIntent(prompt: string): boolean {
  const normalized = prompt.replace(/\r\n?/gu, "\n");
  return (
    /\b(?:do\s+not|don't|never|without)\b[^.;\n]{0,120}\b(?:export|copy|deliver|write|save|create|put|place)(?:ing)?\b[^.;\n]{0,140}\b(?:outside|beyond|off)\s+(?:of\s+)?(?:the\s+)?(?:sandbox|workspace)\b/iu.test(
      normalized,
    ) ||
    /\b(?:keep|leave|retain)\b[^.;\n]{0,100}\b(?:inside|in)\s+(?:the\s+)?(?:sandbox|workspace)\b[^.;\n]{0,40}\b(?:only)?\b/iu.test(
      normalized,
    ) ||
    /\b(?:sandbox|workspace)[ -]?only\b/iu.test(normalized) ||
    /\bno\s+(?:(?:host|desktop|documents?|downloads?|vault[- ]sibling)\s+)?(?:export|delivery|copy)\b/iu.test(
      normalized,
    )
  );
}

export function hasExplicitNewWorkspaceFileIntent(prompt: string): boolean {
  if (extractExplicitNewWorkspaceFilePaths(prompt).length > 0) return true;
  const relativeFilePath = /(?:^|[\s,`])(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12}(?=$|[\s,;:`])/iu;
  return prompt
    .split(/(?:[!?;\r\n]+|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      const action = /\b(?:create|new|add\s+only)\b/iu.exec(clause);
      if (!action) {
        return /\b(?:create|add|new)\b[\s\S]{0,80}\b(?:file|module|component|class|test)\b/iu.test(
          clause,
        );
      }
      const prefix = clause.slice(0, action.index);
      if (/(?:\bdo\s+not\b|\bdon't\b|\bnever\b|\bwithout\b)[\s\S]{0,80}$/iu.test(prefix)) {
        return false;
      }
      return relativeFilePath.test(clause.slice(action.index + action[0].length));
    });
}

export function hasAffirmativeCodePathAction(prompt: string, action: RegExp): boolean {
  return prompt
    .split(/(?:[.!?;\r\n]+|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      const match = action.exec(clause);
      if (!match) return false;
      const prefix = clause.slice(0, match.index);
      if (
        /(?:\bdo\s+not\b|\bdon't\b|\bnever\b|\bwithout\b)[\s\S]{0,80}$/iu.test(
          prefix,
        )
      ) {
        return false;
      }
      return /\b(?:file|folder|directory|path|workspace)\b/iu.test(clause);
    });
}

export function hasHtmlPreviewIntent(prompt: string): boolean {
  return /\b(preview|render|show)\b[\s\S]{0,100}\b(html|css|web\s+page|mockup|prototype)\b|\b(html|css|web\s+page|mockup|prototype)\b[\s\S]{0,100}\b(preview|render|show)\b/i.test(
    prompt,
  );
}

export function hasDesignIntent(prompt: string): boolean {
  return hasSharedDesignIntent(prompt);
}

export function hasDesignPackageIntent(prompt: string): boolean {
  return /\b(design\s*package|service\s*blueprint|logistics\s*system|project\s*ideation|canvas\s+plus\s+(brief|markdown)|canvas[\s\S]{0,80}(?:brief|svg\s+image|image)|brief\s+plus\s+canvas|ui\s*flow|mind\s*map|distributed(?:\s+\w+){0,3}\s+systems?|cloud\s+architecture|microservices?(?:\s+architecture)?|event[-\s]?driven\s+architecture|c4\s+(?:model|diagram)|business\s+process(?:es)?|manufacturing(?:\s+\w+){0,2}\s+process(?:es)?|production\s+lines?|plant\s+workflows?|value\s+streams?|bpmn|sipoc)\b/i.test(
    prompt,
  );
}

export function hasCanvasDesignIntent(prompt: string): boolean {
  if (hasExplicitCanvasDestinationIntent(prompt)) {
    return true;
  }
  if (hasSvgDesignIntent(prompt) || hasMermaidDesignIntent(prompt)) {
    return false;
  }
  return (
    /\b(canvas|mind\s*map|concept\s*map|flowchart|workflow|user\s*flows?|ui\s*flows?|process\s*map|research\s*map|architecture\s*diagram|software\s+architecture|system\s+design|systems?\s+charts?|distributed(?:\s+\w+){0,3}\s+systems?|cloud\s+architecture|microservices?(?:\s+architecture)?|event[-\s]?driven\s+architecture|c4\s+(?:model|diagram)|network\s+topology|data\s+architecture|business\s+process(?:es)?|manufacturing(?:\s+\w+){0,2}\s+process(?:es)?|production\s+lines?|plant\s+workflows?|value\s+streams?|bpmn|sipoc|dependency\s*map|visual\s*map|diagram)\b/i.test(
      prompt,
    ) ||
    (hasDesignIntent(prompt) && !hasSvgDesignIntent(prompt))
  );
}

export function hasSvgDesignIntent(prompt: string): boolean {
  return /\b(svg|wireframe|mockup|screen|layout|ui\s+design|static\s+diagram|sketch)\b/i.test(
    prompt,
  );
}

export function hasBrowserAutomationIntent(prompt: string): boolean {
  return /\b(browser|web\s*acting|open\s+(?:the\s+)?page|open\s+(?:a\s+)?url|navigate|click|scroll|type\s+into|keypress|screenshot|extract\s+markdown|page\s+to\s+markdown|learn\s+(?:this\s+)?(?:page|site|workflow|game)|flash\s+game|swf)\b/i.test(
    prompt,
  );
}

export function hasExperienceMemoryIntent(prompt: string): boolean {
  return /\b(experience\s+memory|episodic\s+memory|semantic\s+memory|procedural\s+memory|source\s+memory|memory\s+search|memory\s+write|memory\s+(?:delete|clear|forget)|(?:delete|clear|forget|remove)\s+(?:the\s+|my\s+|this\s+)?(?:experience\s+)?memor(?:y|ies)|store\s+(?:an?\s+)?memory|remember\s+this|learned\s+strategy)\b/i.test(
    prompt,
  );
}

export function hasLongResearchIntent(prompt: string): boolean {
  return /\b(deep\s+research|long\s+research|in-depth\s+research|deep\s+dive|investigate|compare\s+sources|multi[-\s]?source|strategy|broad\s+constraints|evidence\s+ledger|checkpoint|long[-\s]?running)\b/i.test(
    prompt,
  );
}

export function hasTemplateIntent(prompt: string): boolean {
  if (
    /\bwithout\s+(?:opening|reading|using)\s+(?:it|them)?[\s\S]{0,120}\btemplates?[\\/]\S+\.md\b/iu.test(
      prompt,
    )
  ) {
    return false;
  }
  // Do not match bare "form" ("in the form of", "form a plan") — that falsely
  // exposed template tools on ordinary research missions.
  return /\b(template|templates|templated|boilerplate|reusable\s+(?:note|markdown|outline|format|structure)|fill\s+(?:this|the)?\s*(?:out\s+)?(?:form|template)|populate\s+(?:this|the)?\s*(?:form|template))\b/i.test(
    prompt,
  );
}

export function shouldRequireLinearIssueTemplateRead(
  prompt: string,
  allowedToolNames: ReadonlySet<string>,
): boolean {
  return (
    allowedToolNames.has("read_template") &&
    hasLinearIssueTemplateIntent(prompt)
  );
}

export function getExplicitLinearTemplatePathOverride(prompt: string): string | null {
  const normalized = prompt.replace(/\\/gu, "/");
  const labeledPath = normalized.match(
    /\btemplates?(?:\s+(?:file|path))?\s+(?:(?:at|named|called|from)\s+)?["'`]?([A-Za-z0-9 .@()[\]_-]+?(?:\/[A-Za-z0-9 .@()[\]_-]+?)+\.md)["'`]?(?=\s*[,.;:]|\s+(?:to|for|then|and|create|with)\b|\s*$)/iu,
  )?.[1]?.trim();
  if (labeledPath) {
    return labeledPath;
  }
  for (const path of extractMarkdownPathMentions(normalized)) {
    const pathIndex = normalized.toLowerCase().indexOf(path.toLowerCase());
    if (pathIndex < 0) continue;
    const context = normalized.slice(
      Math.max(0, pathIndex - 100),
      Math.min(normalized.length, pathIndex + path.length + 100),
    );
    if (/\btemplates?\b/iu.test(context)) {
      return path;
    }
  }
  return null;
}

/**
 * Safety gate: reject host-internal metadata leaking into provider-visible
 * fields. This is a hard block, not a formatting nudge.
 */
export function getUnsafeModelLinearIssueCreateOutputMessage(
  toolCall: ModelToolCall,
): string | null {
  if (toolCall.name !== "linear_create_issue") {
    return null;
  }
  for (const [field, label] of [
    ["title", "Linear issue title"],
    ["description", "Linear issue description"],
  ] as const) {
    const value = toolCall.arguments[field];
    if (typeof value !== "string") {
      continue;
    }
    try {
      assertCleanLinearHumanOutputV1(value, label);
    } catch (error) {
      return getErrorMessage(error);
    }
  }
  return null;
}

/**
 * Format gate: hold a model-authored issue to the managed template's section
 * contract. Callers apply this only to ticket-shaped missions — the same signal
 * that already forces the template read, so reading it and using it are now
 * enforced together. An ordinary "open an issue for X" stays free-form.
 *
 * A returned message names the exact sections at fault so the host's existing
 * one-shot schema-correction path can hand the model something actionable.
 */
export function getModelLinearIssueTemplateStructureProblem(
  toolCall: ModelToolCall,
): string | null {
  if (toolCall.name !== "linear_create_issue") {
    return null;
  }
  const title = toolCall.arguments.title;
  if (typeof title === "string") {
    const titleProblem = getLinearIssueTitleProblemV1(title);
    if (titleProblem) {
      return titleProblem;
    }
  }
  const description = toolCall.arguments.description;
  if (typeof description !== "string") {
    return "Linear issue description is required and must use the managed issue-template sections.";
  }
  try {
    assertLinearIssueBodyV1(description, "Linear issue description");
  } catch (error) {
    return getErrorMessage(error);
  }
  return null;
}

/**
 * Linear issue mutations are shaped from the managed vault template even when
 * the user does not mention templates. Reads, comments, and ordinary uses of
 * the word "linear" must not gain template access. Essay/content "write …"
 * far from Linear issue language must not count (e.g. write an essay, then
 * turn it into linear issues — that is turn-into mutation, not write-as-mutation).
 */
export function hasLinearIssueTemplateIntent(prompt: string): boolean {
  if (!detectLinearIntent(prompt).explicit) {
    return false;
  }
  const normalized = prompt.replace(/\r\n?/gu, "\n");
  if (
    /\b(?:do\s+not|don't|never)\b[\s\S]{0,80}\b(?:create|draft|write|prepare|shape|format|publish)\b[\s\S]{0,120}\b(?:linear\s+)?(?:issues?|tickets?)\b/iu.test(
      normalized,
    ) &&
    !/\b(?:create|draft|write|prepare|shape|format|publish)\b[\s\S]{0,80}\b(?:exactly\s+one|one)\b[\s\S]{0,40}\b(?:linear\s+)?(?:issue|ticket)\b/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    hasExplicitResearchPublicationIntent(normalized) ||
    hasExplicitResearchProjectHierarchyIntent(normalized)
  ) {
    return true;
  }
  if (/\blinear_create_issue\b/iu.test(normalized)) {
    return true;
  }
  // Mutation verbs must sit near Linear issue language — not a distant essay
  // "write" within a loose 240-char window of later "linear issues".
  if (
    /\b(?:create|draft|prepare|shape|format|publish|open)\b[\s\S]{0,100}\b(?:linear\s+)?(?:issues?|tickets?)\b/iu.test(
      normalized,
    ) ||
    /\b(?:linear\s+)?(?:issues?|tickets?)\b[\s\S]{0,100}\b(?:create|draft|prepare|shape|format|publish)\b/iu.test(
      normalized,
    ) ||
    /\b(?:create|draft|write|prepare|shape|format|publish)\b[\s\S]{0,80}\b(?:issues?|tickets?)\b[\s\S]{0,40}\bin\s+linear\b/iu.test(
      normalized,
    ) ||
    /\bwrite\b[\s\S]{0,60}\b(?:linear\s+)?(?:issues?|tickets?)\b/iu.test(
      normalized,
    ) ||
    /\bturn\b[\s\S]{0,100}\binto\b[\s\S]{0,40}\b(?:linear\s+)?(?:issues?|tickets?)\b/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

export function hasTemplateCreateIntent(prompt: string): boolean {
  return (
    /\b(create|new|make|save)\b[\s\S]{0,100}\b(template|boilerplate|reusable\s+(?:note|markdown|outline|format|structure))\b|\b(template|boilerplate|reusable\s+(?:note|markdown|outline|format|structure))\b[\s\S]{0,100}\b(create|new|make|save)\b/i.test(
      prompt,
    ) && !hasCreateNoteFromTemplateIntent(prompt)
  );
}

export function hasTemplateSeedIntent(prompt: string): boolean {
  return /\b(seed|install|create|make|add)\b[\s\S]{0,120}\b(default|starter|example|sample|built[-\s]?in)\b[\s\S]{0,80}\btemplates?\b|\b(default|starter|example|sample|built[-\s]?in)\b[\s\S]{0,80}\btemplates?\b[\s\S]{0,120}\b(seed|install|create|make|add)\b/i.test(
    prompt,
  );
}

export function hasTemplateFillIntent(prompt: string): boolean {
  return /\b(fill|use|apply|complete|populate|render)\b[\s\S]{0,100}\b(template|form|boilerplate)\b|\b(template|form|boilerplate)\b[\s\S]{0,100}\b(fill|use|apply|complete|populate|render)\b|\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b[\s\S]{0,80}\bfrom\b[\s\S]{0,80}\btemplate\b|\bfrom\b[\s\S]{0,80}\btemplate\b[\s\S]{0,80}\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b/i.test(
    prompt,
  );
}

/**
 * Set-loose may need the one configured Linear issue template without gaining
 * authority to enumerate every vault template. Keep list_templates available
 * only when the user actually asked about templates; read_template remains a
 * separate host-selected dependency for accepted-research publication.
 */
export function constrainSetLooseTemplateDiscoveryToMissionIntent(
  toolNames: readonly string[],
  prompt: string,
): string[] {
  const mayListTemplates =
    hasTemplateIntent(prompt) &&
    !hasLinearIssueTemplateIntent(prompt);
  return [
    ...new Set(
      toolNames
        .map((toolName) => toolName.trim())
        .filter(Boolean)
        .filter(
          (toolName) => toolName !== "list_templates" || mayListTemplates,
        ),
    ),
  ];
}

export function hasCreateNoteFromTemplateIntent(prompt: string): boolean {
  return /\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b[\s\S]{0,100}\bfrom\b[\s\S]{0,80}\btemplate\b|\btemplate\b[\s\S]{0,100}\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b/i.test(
    prompt,
  );
}

export function hasCheckpointResumeIntent(prompt: string): boolean {
  return hasMissionResumeIntent(prompt);
}

export function hasCurrentNoteReadIntent(prompt: string): boolean {
  return (
    isPromptOnCurrentPageIntent(prompt) ||
    /\b(current|this|active)\s+(note|file|markdown|document|page)\b|\b(note|file|markdown|document|page)\b[\s\S]{0,40}\b(current|this|active)\b|\b(summarize|summary|append|replace|rewrite|reset|overwrite|edit|revise|delete|remove|trash|retitle|title|heading|h1|organize|restructure|clean\s+up)\b[\s\S]{0,80}\b(note|file|markdown|document|page)\b|\b(note|file|markdown|document|page)\b[\s\S]{0,80}\b(summarize|summary|append|replace|rewrite|reset|overwrite|edit|revise|delete|remove|trash|retitle|title|heading|h1|organize|restructure|clean\s+up)\b/i.test(
      prompt,
    )
  );
}

export function hasGeneratedWritingIntent(prompt: string): boolean {
  return /\b(write|draft|compose|generate|create)\b[\s\S]{0,100}\b(essay|article|paragraph|summary|brief|outline|report|analysis|response|answer|markdown|content|write[-\s]?up)\b|\b(essay|article|paragraph|summary|brief|outline|report|analysis|response|answer|markdown|content|write[-\s]?up)\b[\s\S]{0,100}\b(write|draft|compose|generate|create)\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,80}\b\d{1,5}\s*words?\b/i.test(
    prompt,
  );
}

/**
 * Narrative output that is independently destined for the notebook before a
 * later provider handoff. Provider-field wording such as "Markdown
 * description" or "issue content" is intentionally excluded.
 */
export function hasDistinctNarrativeDraftIntent(prompt: string): boolean {
  return /\b(write|draft|compose|generate|create)\b[\s\S]{0,100}\b(essay|article|paragraph|summary|brief|outline|report|analysis|write[-\s]?up|findings|digest|recap|literature\s+review)\b|\b(essay|article|paragraph|summary|brief|outline|report|analysis|write[-\s]?up|findings|digest|recap|literature\s+review)\b[\s\S]{0,100}\b(write|draft|compose|generate|create)\b/iu.test(
    prompt,
  );
}

export function hasCurrentPageWritebackIntent(prompt: string): boolean {
  return (
    /\b(stream|write|append|save|add|insert|put|record|generate|draft|compose|create)\b[\s\S]{0,120}\b(?:onto|to|into|in|on)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b/i.test(
      prompt,
    ) ||
    /\b(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,120}\b(stream|write|append|save|add|insert|put|record|generate|draft|compose|create)\b/i.test(
      prompt,
    )
  );
}

export function hasExplicitStreamToCurrentNoteIntent(prompt: string): boolean {
  return (
    /\bstream(?:ing)?\b[\s\S]{0,120}\b(?:onto|to|into|in|on)\s+(?:this|the|current|active)?\s*(?:page|note|document|file)\b/i.test(
      prompt,
    ) ||
    /\b(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,120}\bstream(?:ing)?\b/i.test(
      prompt,
    )
  );
}

export function hasCurrentNoteSectionTarget(prompt: string): boolean {
  return /\b(?:below|under|after|beneath|inside)\b[\s\S]{0,100}\b(?:section|heading)\b|\b(?:section|heading)\b[\s\S]{0,100}\b(?:below|under|after|beneath|inside)\b/i.test(
    prompt,
  );
}

export function hasSectionAppendIntent(prompt: string): boolean {
  return (
    hasCurrentNoteSectionTarget(prompt) &&
    /\b(write|draft|compose|generate|append|add|insert|put)\b/i.test(prompt)
  );
}

export function hasResearchMemoryIntent(prompt: string): boolean {
  return (
    hasResearchMemoryReadIntent(prompt) ||
    hasResearchMemoryWriteIntent(prompt) ||
    hasResearchMemoryReviewIntent(prompt) ||
    hasResearchMemoryCompactIntent(prompt) ||
    hasResearchMemoryDeleteIntent(prompt)
  );
}

export function hasResearchMemoryReadIntent(prompt: string): boolean {
  return /\b(research\s+memory|topic\s+memory|memory|remember|recall|long[-\s]?term|continue\s+(?:this|the)\s+research|build\s+on\s+(?:this|the)\s+research)\b/i.test(
    prompt,
  );
}

export function hasResearchMemoryWriteIntent(prompt: string): boolean {
  return /\b(save|store|remember|record|persist|append|add|update)\b[\s\S]{0,120}\b(research\s+memory|topic\s+memory|memory|long[-\s]?term|research\s+topic)\b|\b(research\s+memory|topic\s+memory|memory|long[-\s]?term|research\s+topic)\b[\s\S]{0,120}\b(save|store|remember|record|persist|append|add|update)\b/i.test(
    prompt,
  );
}

export function hasResearchMemoryReviewIntent(prompt: string): boolean {
  return /\b(review|audit|inspect|check|hygiene|duplicates?|stale|clean(?:up)?)\b[\s\S]{0,120}\b(research\s+memory|topic\s+memory|memory)\b|\b(research\s+memory|topic\s+memory|memory)\b[\s\S]{0,120}\b(review|audit|inspect|check|hygiene|duplicates?|stale|clean(?:up)?)\b/i.test(
    prompt,
  );
}

export function hasResearchMemoryCompactIntent(prompt: string): boolean {
  return /\b(compact|compress|summari[sz]e|dedupe|merge|clean(?:up)?)\b[\s\S]{0,120}\b(research\s+memory|topic\s+memory|memory)\b|\b(research\s+memory|topic\s+memory|memory)\b[\s\S]{0,120}\b(compact|compress|summari[sz]e|dedupe|merge|clean(?:up)?)\b/i.test(
    prompt,
  );
}

export function hasResearchMemoryDeleteIntent(prompt: string): boolean {
  return /\b(delete|remove|trash|forget)\b[\s\S]{0,120}\b(research\s+memory|topic\s+memory|memory|research\s+topic)\b|\b(research\s+memory|topic\s+memory|memory|research\s+topic)\b[\s\S]{0,120}\b(delete|remove|trash|forget)\b/i.test(
    prompt,
  );
}

export function hasIgnoreRememberedContextIntent(prompt: string): boolean {
  return /\b(?:ignore|exclude|skip|do\s+not\s+use|don't\s+use|without)\b[\s\S]{0,100}\b(?:remembered|prior|saved|research|experience)\s+(?:context|memory|memories)\b|\b(?:remembered|prior|saved|research|experience)\s+(?:context|memory|memories)\b[\s\S]{0,100}\b(?:ignore|exclude|skip|do\s+not\s+use|don't\s+use)\b/iu.test(
    prompt,
  );
}

export function hasNamedFolderTraversalIntent(prompt: string): boolean {
  return (
    /\b(traverse|inspect|browse|read|look\s+through|check|summari[sz]e)\b[\s\S]{0,120}\bfolders?\b/i.test(
      prompt,
    ) &&
    /\bfolders?\b[\s\S]{0,100}\b(?:named|called)\b/i.test(prompt)
  );
}

export function extractNamedVaultFolders(prompt: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bfolders?\s+(?:are\s+)?(?:named|called)\s+([^.\n]+)/gi,
    /\bthey\s+(?:are\s+)?(?:named|called)\s+([^.\n]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const rawList = match[1] ?? "";
      for (const raw of rawList.split(/\s*,\s*|\s+\band\s+/i)) {
        const name = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
        if (name) {
          names.add(name);
        }
      }
    }
  }

  return [...names];
}

export function buildVaultPrefetchArgs(prompt: string): Record<string, unknown> {
  const targetFolders = extractNamedVaultFolders(prompt);
  if (targetFolders.length > 0) {
    return {
      scope: "all_vault",
      targetFolders,
    };
  }

  return { scope: "other_folders" };
}

export function hasVaultBrowseIntent(prompt: string): boolean {
  // "List my saved templates" contains "list" but is a template mission, not a
  // vault-file browse mission. Keep template prompts on template tools.
  if (/\btemplates?\b/i.test(prompt)) {
    return false;
  }
  return /\b(vault|files|file names|filenames|markdown files|md files|folders|folder|directory|directories|path|paths|list|browse|inspect|where\s+this\s+note\s+belongs|placement|organize\s+(?:the\s+)?vault|across\s+files)\b/i.test(
    prompt,
  );
}

export function hasFolderContentQuestionIntent(prompt: string): boolean {
  return (
    hasNamedFolderTraversalIntent(prompt) ||
    /\b(other|all|nearby|related|vault|my)\s+(folders?|notes?|files?)\b/i.test(
      prompt,
    ) ||
    /\b(folders?|vault)\b[\s\S]{0,100}\b(say|says|contain|contains|details?|contents?|report\s+back|gather|browse|locate|summari[sz]e|tell\s+me)\b/i.test(
      prompt,
    ) ||
    /\b(gather|collect|read|inspect|look\s+through|browse|check|summari[sz]e|report)\b[\s\S]{0,140}\b(other\s+)?(folders?|vault|my\s+notes|notes?\s+in\s+(?:the\s+)?other\s+folders?|files?\s+in\s+(?:the\s+)?other\s+folders?)\b/i.test(
      prompt,
    )
  );
}

export function hasSpecificFileReadIntent(prompt: string): boolean {
  return /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(file named|note named|named file|named note|specific file|existing file|vault file)\b/i.test(
    prompt,
  );
}

export function hasCreateFileIntent(prompt: string): boolean {
  if (!/\b(create|creating|new|make)\b/i.test(prompt)) {
    return false;
  }

  if (hasStaticGenerationIntent(prompt) && !/\b(file|note|vault|path)\b|\.md\b/i.test(prompt)) {
    return false;
  }

  // Require create/new/make to bind to a file/note target. A bare ".md" path
  // mention plus unrelated "new" wording (e.g. "new findings") must not invent
  // a create_file mission node ahead of append/stream writeback.
  return (
    /\b(create|creating|make)\b[\s\S]{0,100}\b(note|file|md|vault|markdown)\b|\b(note|file|md|vault|markdown)\b[\s\S]{0,100}\b(create|creating|make)\b|\bnew\s+(?:markdown\s+)?(?:note|file)\b|\b(?:create|creating|make|new)\b[\s\S]{0,120}\.md\b/i.test(
      prompt,
    )
  );
}

export function hasCreateFolderIntent(prompt: string): boolean {
  return /\b(?:create|creating|make)\s+(?:(?:a|the)\s+)?(?:(?:new)\s+)?(?:folder|directory)\b|\bnew\s+(?:folder|directory)\b/i.test(
    prompt,
  );
}

export function hasPathTargetIntent(prompt: string): boolean {
  return /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(path|folder|folders|directory|directories|vault file|vault folder|file named|note named|named file|named note|another file|specific file|existing file)\b/i.test(
    prompt,
  );
}

export function hasResearchPackIntent(prompt: string): boolean {
  return /\b(create|make|build|generate|save)\b[\s\S]{0,120}\b(research\s+pack|research\s+brief|sources?\s+index|synthesis\s+pack|transactional\s+pack)\b|\b(research\s+pack|research\s+brief|sources?\s+index|synthesis\s+pack|transactional\s+pack)\b[\s\S]{0,120}\b(create|make|build|generate|save)\b/i.test(
    prompt,
  );
}

export function hasExplicitNonCurrentPathTarget(prompt: string): boolean {
  const clauses = prompt.split(
    /(?:[.;!?\n]+|,\s*|\b(?:and\s+then|then)\b)/giu,
  );
  const mutation =
    /\b(?:append|save|write|update|add|insert|copy|paste|put|replace|rewrite|reset|overwrite|create|make|move|relocate|rename|delete|remove|trash)\b/iu;
  const nonCurrentTarget =
    /[A-Za-z0-9.@()[\]_-]+(?:\/[A-Za-z0-9.@()[\]_-]+)+(?:\.md)?\b|\b[A-Za-z0-9][A-Za-z0-9 .@()_-]{0,100}\.md\b|\b(?:vault\s+(?:file|folder)|(?:file|note|folder|directory)\s+(?:named|called)|named\s+(?:file|note|folder|directory)|another\s+(?:file|note)|specific\s+(?:file|note|folder)|existing\s+(?:markdown\s+)?(?:file|note))\b/iu;

  return clauses.some((clause) => {
    const mutationMatch = mutation.exec(clause);
    const targetMatch = nonCurrentTarget.exec(clause);
    return Boolean(
      mutationMatch &&
        targetMatch &&
        (mutationMatch.index ?? 0) < (targetMatch.index ?? 0),
    );
  });
}

export function hasMermaidCreateThenReviseIntent(prompt: string): boolean {
  return (
    hasMermaidDesignIntent(prompt) &&
    hasReviseDesignIntent(prompt) &&
    /\b(create|add|insert|draw|make|build)\b/iu.test(prompt)
  );
}

export function getExplicitMermaidWorkflowToolNames(prompt: string): string[] {
  if (!hasReviseDesignIntent(prompt) || !hasMermaidDesignIntent(prompt)) {
    return [];
  }
  return hasMermaidCreateThenReviseIntent(prompt)
    ? [
        "read_mermaid_block",
        "upsert_mermaid_block",
        "read_mermaid_block",
        "upsert_mermaid_block",
        "read_mermaid_block",
      ]
    : ["read_mermaid_block", "upsert_mermaid_block"];
}

export function extractExplicitMermaidReadBinding(
  prompt: string,
): {
  path: string;
  selector: { kind: "heading"; heading: string };
} | null {
  const pathMatches = [
    ...prompt.matchAll(
      /\bexact\s+vault-relative\s+path\s+["']([^"'\r\n]+\.md)["']/giu,
    ),
  ];
  const headingMatches = [
    ...prompt.matchAll(
      /\bexact\s+heading\s+["']([^"'\r\n]+)["']/giu,
    ),
  ];
  if (pathMatches.length !== 1 || headingMatches.length !== 1) {
    return null;
  }
  const path = pathMatches[0]?.[1]?.trim() ?? "";
  const heading = headingMatches[0]?.[1]?.trim() ?? "";
  if (
    !path ||
    !heading ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /(^|\/)\.\.(?:\/|$)/u.test(path)
  ) {
    return null;
  }
  return {
    path,
    selector: { kind: "heading", heading },
  };
}

export function getExplicitSemanticRetrievalWorkflowToolNames(prompt: string): string[] {
  if (!hasExplicitSemanticRetrievalIntent(prompt)) {
    return [];
  }
  return ["semantic_search_notes", "read_markdown_files"];
}

export function hasExplicitSemanticRetrievalIntent(prompt: string): boolean {
  return /\b(?:semantic\s+(?:retrieval|search)|semantic_search_notes)\b/iu.test(
    prompt,
  );
}

export function getExplicitVaultCrudWorkflowToolNames(prompt: string): string[] {
  if (
    isVisibleTitleRenameIntent(prompt) &&
    hasExplicitCurrentNoteMutationIntent(prompt) &&
    // This exact frontier is only for the explicit rename -> move lifecycle.
    // A rename embedded in research must retain its graph/web read nodes; using
    // rename alone as the discriminator previously collapsed those missions to
    // rename + append and made their evidence obligations impossible.
    hasMovePathIntent(prompt)
  ) {
    return [
      "rename_current_file",
      ...(hasMovePathIntent(prompt) ? ["move_path"] : []),
      ...(hasAppendIntent(prompt) ? ["append_to_current_file"] : []),
    ];
  }
  if (
    !hasCreateFileIntent(prompt) ||
    !hasMovePathIntent(prompt) ||
    !hasDeletePathIntent(prompt)
  ) {
    return [];
  }
  return [
    ...(hasCreateFolderIntent(prompt) ? ["create_folder"] : []),
    "create_file",
    ...(hasAppendIntent(prompt) ? ["append_file"] : []),
    ...(hasReplaceIntent(prompt) ? ["replace_file"] : []),
    "move_path",
    "delete_path",
  ];
}

export function hasExplicitNonCurrentNoteWriteTarget(prompt: string): boolean {
  return (
    hasExplicitNonCurrentPathTarget(prompt) &&
    (hasAppendIntent(prompt) ||
      hasReplaceIntent(prompt) ||
      hasCreateFileIntent(prompt) ||
      hasCreateFolderIntent(prompt) ||
      hasMovePathIntent(prompt) ||
      hasDeletePathIntent(prompt))
  );
}

export function hasCurrentNoteTarget(prompt: string): boolean {
  return /\b(current|this|active)\s+(note|file|markdown|document|page)\b|\b(note|file|markdown|document|page)\b[\s\S]{0,40}\b(current|this|active)\b/i.test(
    prompt,
  );
}

export function hasNoteOutputIntent(prompt: string): boolean {
  if (hasChatOnlyResponseIntent(prompt)) {
    return false;
  }

  const generated = analyzeGeneratedOutputPrompt(prompt);
  if (
    generated.target === "current_note_append" ||
    generated.target === "current_note_replace"
  ) {
    return true;
  }

  if (
    hasAppendIntent(prompt) ||
    hasWholeNoteRevisionIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasTitleIntent(prompt) ||
    hasHighlightIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasSectionAppendIntent(prompt) ||
    hasResearchMemoryWriteIntent(prompt) ||
    hasCreateFileIntent(prompt) ||
    hasCreateFolderIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasDeleteIntent(prompt) ||
    hasDeletePathIntent(prompt)
  ) {
    return true;
  }

  if (hasStaticGenerationIntent(prompt) && !hasFetchedWebSourceIntent(prompt)) {
    return false;
  }

  return /\b(research|investigate|analy[sz]e|synthesi[sz]e|summari[sz]e|summary|outline|brief|report|literature\s+review|field\s+notes?|meeting\s+notes?|findings|digest|recap|write[-\s]?up|cited\s+sources?|citations?)\b/i.test(
    prompt,
  );
}

export function hasAppendIntent(prompt: string): boolean {
  // Scope restrictions constrain *where* an already-requested mutation may
  // occur; they are not a second append instruction. Without this removal,
  // "Create X.md ... Only write to that requested file" manufactures an
  // append_file node ahead of create_file and deadlocks the exact graph.
  const intentPrompt = prompt.replace(
    /\b(?:only|just)\s+(?:write|save|put)\s+(?:to|in|into)\s+(?:that|the)\s+(?:requested|specified|named|target(?:ed)?)\s+(?:file|note|path)\b/giu,
    " ",
  );
  // Snake_case tool names are one \w token, so \bappend\b never matches inside
  // append_to_current_file — accept the named vault append tool explicitly.
  if (/\bappend_to_current_file\b/i.test(intentPrompt)) {
    return true;
  }
  return /\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,80}\b(note|file|markdown|vault|page|document)\b|\b(note|file|markdown|vault|page|document)\b[\s\S]{0,80}\b(append|save|write|update|add|insert|copy|paste|put)\b|\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,120}\.md\b/i.test(
    intentPrompt,
  );
}

export function hasReplaceIntent(prompt: string): boolean {
  const positivePrompt = prompt
    .replace(
      /\b(?:do\s+not|don't|never)\s+(?:rewrite|replace|reset|overwrite)\b[^.;\n]*/giu,
      " ",
    )
    .replace(
      /\bwithout\s+(?:rewriting|replacing|resetting|overwriting)\b[^.;\n]*/giu,
      " ",
    );
  return (
    isCurrentNoteReplaceResetPrompt(positivePrompt) ||
    hasWholeNoteRevisionIntent(positivePrompt) ||
    /\b(rewrite|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+(?:fresh|cleanly)\b|\bedit\s+over\s+(?:it|this|the\s+(?:note|page|document|file|contents?))\b|\breplace\s+(?:the\s+)?existing\s+contents?\b/i.test(
      positivePrompt,
    ) || hasClearPageAndWriteIntent(positivePrompt)
  );
}

export function hasWholeNoteReplaceIntent(prompt: string): boolean {
  if (
    (isCurrentNoteReplaceResetPrompt(prompt) &&
      hasExplicitCurrentNoteMutationIntent(prompt)) ||
    hasWholeNoteRevisionIntent(prompt)
  ) {
    return true;
  }

  if (!hasReplaceIntent(prompt)) {
    return false;
  }

  return (
    hasClearPageAndWriteIntent(prompt) ||
    /\b(rewrite|replace|reset|overwrite|clean\s+up|start\s+(?:fresh|cleanly)|edit\s+over)\b[\s\S]{0,100}\b(current|this|active|whole|entire|existing)\s+(note|file|markdown|document|page|content|contents)\b|\b(current|this|active|whole|entire|existing)\s+(note|file|markdown|document|page|content|contents)\b[\s\S]{0,100}\b(rewrite|replace|reset|overwrite|clean\s+up|start\s+(?:fresh|cleanly)|edit\s+over)\b/i.test(
      prompt,
    )
  );
}

export function hasClearPageAndWriteIntent(prompt: string): boolean {
  return /\b(clear|delete|remove)\s+all\s+(?:the\s+)?(?:notes?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,180}\b(write|draft|compose|generate|create)\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,180}\b(?:after|then)\b[\s\S]{0,120}\b(clear|delete|remove)\s+all\s+(?:the\s+)?(?:notes?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b/i.test(
    prompt,
  );
}

export function hasWholeNoteRevisionIntent(prompt: string): boolean {
  if (isNamedSectionEditIntent(prompt)) {
    return false;
  }

  if (
    isWholeNoteEditIntent(prompt) ||
    isCurrentNoteEditOrganizeIntent(prompt)
  ) {
    return true;
  }

  const sectionTarget =
    /\b(section|heading)\b/i.test(prompt) &&
    !/\b(essay|draft|article|paragraphs?|body|content|document)\b/i.test(
      prompt,
    );
  if (sectionTarget) {
    return false;
  }

  if (
    hasAppendIntent(prompt) &&
    !/\b(?:rewrite|replace|reset|overwrite|whole|entire)\b/iu.test(prompt)
  ) {
    // Append-first authority: a generic request to "expand" research or
    // related-note coverage must not become whole-note replacement merely
    // because the destination is the current note.
    return false;
  }

  const revisionVerb =
    /\b(edit(?:ing)?|revise|revising|revised|revision|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail|correct(?:ing)?|fix(?:ing)?|proofread(?:ing)?|polish(?:ing)?)\b/i;
  const wholeTextTarget =
    /\b(essay|draft|article|paragraphs?|body|content|document|version)\b|\b(?:whole|entire|current|this|active)\s+(?:note|page|file|markdown)\b|\b(?:note|page|file|markdown)\b[\s\S]{0,40}\b(?:whole|entire|current|this|active)\b/i;
  const updateVerb = /\b(update|updating)\b/i;

  return (
    revisionVerb.test(prompt) && wholeTextTarget.test(prompt)
  ) || (
    updateVerb.test(prompt) &&
    /\b(essay|draft|article|paragraphs?|body|content|document)\b|\b(?:whole|entire)\s+(?:note|page|file|markdown)\b/i.test(
      prompt,
    )
  );
}

export function hasEditIntent(prompt: string): boolean {
  return isNamedSectionEditIntent(prompt);
}

export function hasExplicitObsidianVaultMutationTarget(prompt: string): boolean {
  return (
    /\bobsidian\b|\bvault(?:-relative)?\b/iu.test(prompt) ||
    /\b(?:current|active|this)\s+(?:note|page|markdown(?:\s+file)?)\b/iu.test(
      prompt,
    ) ||
    /\b(?:note|markdown\s+note)\s+(?:named|called)\b/iu.test(prompt)
  );
}

export function hasNegatedDeleteClause(clause: string): boolean {
  return /\b(?:do\s+not|don't|never|without|avoid)\b[\s\S]{0,80}\b(?:delete|remove|trash)\b/iu.test(
    clause,
  );
}

export function hasDeleteIntent(prompt: string): boolean {
  if (
    isCurrentNoteReplaceResetPrompt(prompt) &&
    hasExplicitCurrentNoteMutationIntent(prompt)
  ) {
    return false;
  }

  return prompt
    .split(/(?:[.;!?\n]+|,\s*|\b(?:and\s+then|then)\b)/giu)
    .some(
      (clause) =>
        /\b(?:delete|remove|trash)\b/iu.test(clause) &&
        !hasNegatedDeleteClause(clause) &&
        /\b(?:current|this|active|whole|entire)\s+(?:note|file)\b|\b(?:note|file)\b[\s\S]{0,40}\b(?:current|this|active|whole|entire)\b/iu.test(
          clause,
        ),
    );
}

export function hasDeletePathIntent(prompt: string): boolean {
  const deleteClauses = prompt
    .split(/(?:[.;!?\n]+|,\s*|\b(?:and\s+then|then)\b)/giu)
    .filter(
      (clause) =>
        /\b(?:delete|remove|trash)\b/iu.test(clause) &&
        !hasNegatedDeleteClause(clause),
    );
  const explicitMarkdownDelete = deleteClauses.some((clause) =>
    extractMarkdownPathMentions(clause).some((path) =>
      new RegExp(
        String.raw`\b(?:delete|remove|trash)\b[\s\S]{0,160}${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
        "iu",
      ).test(clause),
    ),
  );
  if (
    isCurrentNoteReplaceResetPrompt(prompt) &&
    !hasExplicitNonCurrentPathTarget(prompt) &&
    !explicitMarkdownDelete
  ) {
    return false;
  }

  return deleteClauses.some(
    (clause) =>
      hasPathTargetIntent(clause) &&
      (hasExplicitNonCurrentPathTarget(clause) ||
        explicitMarkdownDelete),
  );
}

export function hasMovePathIntent(prompt: string): boolean {
  const explicitPathSyntax =
    /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(path|folder|directory|vault\s+(?:file|folder)|file\s+named|note\s+named|named\s+(?:file|note))\b/i.test(
      prompt,
    );
  if (
    isVisibleTitleRenameIntent(prompt) &&
    hasCurrentNoteTarget(prompt) &&
    !/\b(move|relocate)\b/i.test(prompt) &&
    !explicitPathSyntax
  ) {
    return false;
  }

  const explicitRelocation =
    /\b(move|relocate)\b[\s\S]{0,100}\b(path|file|folder|note|vault|\.md)\b|\b(path|file|folder|note|vault|\.md)\b[\s\S]{0,100}\b(move|relocate)\b/i.test(
      prompt,
    );
  if (explicitRelocation) {
    return true;
  }

  const renamePath =
    /\brename\b[\s\S]{0,100}\b(path|file|folder|note|vault|\.md)\b|\b(path|file|folder|note|vault|\.md)\b[\s\S]{0,100}\brename\b/i.test(
      prompt,
    );
  if (!renamePath) {
    return false;
  }

  // Renaming the visible title of the active note is owned by
  // rename_current_file. Do not also create a generic move_path obligation
  // merely because the phrase "rename the current note" contains "note".
  if (
    isVisibleTitleRenameIntent(prompt) &&
    hasCurrentNoteTarget(prompt) &&
    !explicitPathSyntax
  ) {
    return false;
  }

  return true;
}

export function hasWebSearchIntent(prompt: string): boolean {
  if (hasExplicitNoWebIntent(prompt)) {
    return false;
  }
  if (hasSimpleDateTimePrompt(prompt)) {
    return false;
  }

  if (hasPriorAssistantResponseWritebackIntent(prompt)) {
    return false;
  }

  if (hasTitleOnlyIntent(prompt)) {
    return false;
  }

  if (hasHighlightIntent(prompt)) {
    return false;
  }

  if (/\b(search|use|check|consult)\s+(?:the\s+)?web\b/i.test(prompt)) {
    return true;
  }

  if (hasCurrentWebFactIntent(prompt)) {
    return true;
  }

  if (hasExplicitPublicWebSignal(prompt)) {
    return true;
  }

  if (hasStaticGenerationIntent(prompt) && !hasFetchedWebSourceIntent(prompt)) {
    return false;
  }

  if (hasFolderContentQuestionIntent(prompt)) {
    return false;
  }

  // A path component such as `crud-source-123.md` must not turn a local
  // create/read/replace/move/trash workflow into public-web research. Strong
  // public-network signals were accepted above, so a remaining exact Markdown
  // path is authoritative local scope.
  if (hasSpecificFileReadIntent(prompt)) {
    return false;
  }

  if (hasExplicitWebSearchIntent(prompt) || hasDeepResearchIntent(prompt)) {
    return true;
  }

  return /\b(research|investigate|find|gather)\b/i.test(prompt);
}

export function hasFetchedWebSourceIntent(prompt: string): boolean {
  if (
    hasPrimaryTextCitationIntent(prompt) &&
    !/\b(?:web|online|internet|https?:\/\/|bibliography|reference\s+list|source\s+urls?|verified\s+sources?|fact[-\s]?check|verify\s+(?:sources?|facts?|claims?))\b/iu.test(
      prompt,
    )
  ) {
    return false;
  }
  return /\b(cited\s+sources?|cite\s+sources?|citations?|source\s+urls?|bibliography|reference\s+list|verified\s+sources?|fact[-\s]?check(?:ed)?|verify\s+(?:sources?|facts?|claims?))\b/i.test(
    prompt,
  );
}

export function hasCurrentWebFactIntent(prompt: string): boolean {
  return /\b(?:latest|recent|current|up[-\s]?to[-\s]?date)\b[\s\S]{0,100}\b(?:events?|news|information|info|data|facts?|research|reports?|papers?|studies?|market|markets?|industry|industries|trends?|prices?|rates?|status|versions?|law|policy|policies)\b/i.test(
    prompt,
  );
}

export function hasDeepResearchIntent(prompt: string): boolean {
  return /\b(deep\s+research|in[-\s]?depth\s+(?:research|analysis|investigation)|deep\s+dive|thorough\s+research|comprehensive\s+research|serious\s+research)\b/i.test(
    prompt,
  );
}

export function hasExplicitWebSearchIntent(prompt: string): boolean {
  if (
    hasPrimaryTextCitationIntent(prompt) &&
    !/\b(?:web|internet|online|search|look\s+up|browse|news|up[-\s]?to[-\s]?date|verify|fact[-\s]?check|https?:\/\/)\b/iu.test(
      prompt,
    )
  ) {
    return false;
  }
  return /\b(web|internet|online|search|look\s+up|browse|sources?|citations?|cited|cite|news|up[-\s]?to[-\s]?date|verify|fact[-\s]?check)\b|\b(?:latest|recent|current)\b[\s\S]{0,60}\b(events?|news|information|info|version|versions?|prices?|rates?|status|facts?|research|reports?|papers?|studies?)\b/i.test(
    prompt,
  );
}

export function hasSimpleDateTimePrompt(prompt: string): boolean {
  return /^\s*(?:(?:what(?:'s| is)?|tell me|give me|show me)\s+)?(?:today'?s\s+)?(?:current\s+)?(?:date|time|day)(?:\s+(?:today|now|right now))?\??\s*$/i.test(
    prompt,
  ) || /^\s*what\s+(?:date|time|day)\s+is\s+it(?:\s+(?:today|now|right now))?\??\s*$/i.test(
    prompt,
  );
}

export function hasAmbiguousDatePrompt(prompt: string): boolean {
  if (!/\b(day|days|date|before|after|from)\b/i.test(prompt)) {
    return false;
  }

  const hasMonthDay =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i.test(
      prompt,
    );
  const hasNumericDate = /\b\d{1,2}[/-]\d{1,2}\b/.test(prompt);
  const hasYear = /\b(?:19|20)\d{2}\b/.test(prompt);

  return (hasMonthDay || hasNumericDate) && !hasYear;
}

export function hasStaticGenerationIntent(prompt: string): boolean {
  return /\b(generate|write|draft|compose|create)\b[\s\S]{0,80}\b(essay|article|paragraph|summary|brief|outline|report|note|content|post)\b|\b(essay|article|paragraph|summary|brief|outline|report)\b[\s\S]{0,80}\b\d+\s*words?\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,80}\b\d{1,5}\s*words?\b/i.test(
    prompt,
  );
}

export function hasTitleIntent(prompt: string): boolean {
  return isMarkdownTitleContentIntent(prompt) || isVisibleTitleRenameIntent(prompt);
}

export function hasMarkdownTitleContentIntent(prompt: string): boolean {
  return isMarkdownTitleContentIntent(prompt);
}

export function hasHighlightIntent(prompt: string): boolean {
  return /\b(find|search|locate|show)\b[\s\S]{0,120}\b(highlight|mark)\b|\b(highlight|mark)\b[\s\S]{0,120}\b(word|phrase|text|where|current\s+(?:note|file|page))\b/i.test(
    prompt,
  );
}

export function hasRestoreIntent(prompt: string): boolean {
  return /\b(undo|restore|revert|rollback|roll\s+back)\b[\s\S]{0,140}\b(agent|last|previous|backup|current\s+(?:note|file|page)|this\s+(?:note|file|page))\b|\b(agent|last|previous|backup|current\s+(?:note|file|page)|this\s+(?:note|file|page))\b[\s\S]{0,140}\b(undo|restore|revert|rollback|roll\s+back)\b/i.test(
    prompt,
  );
}

export function hasTitleOnlyIntent(prompt: string): boolean {
  return isTitleOnlyIntent(prompt);
}

export function hasMermaidDesignIntent(prompt: string): boolean {
  return /\bmermaid\b/i.test(prompt);
}
