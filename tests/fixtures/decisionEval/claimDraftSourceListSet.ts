/**
 * Calibration drafts for the second JEV-5 claim-check fix: the sentences the
 * end-to-end comparison of 2026-10-23 showed are held or flagged although they
 * say nothing a passage could support (RAP .agent/reports/jev-5/
 * live-e2e-2026-10-23.md). Every one of Jev's 13 flags on real research drafts
 * was one of four kinds, and none of the frozen V1 drafts held one:
 *
 * - a Sources or References section, or a "**Sources …:**" label, and its list;
 * - a bibliography line: a title, a description and a URL;
 * - a note on how quotations, passage ids or reads were handled;
 * - the model talking to the reader ("Here is the complete corrected note
 *   content:").
 *
 * Each draft also puts a factual sentence beside them, written so that a rule
 * which exempts too much would let it through (`beside`): a factual sentence
 * after a source list, a sentence that cites a URL in passing, a sentence that
 * opens with "Here is" or "Quotations from" and still asserts something. Those
 * must still be checked.
 *
 * Synthetic, written and labelled before any candidate code existed, and
 * frozen with this file's hash. All calibration: the held-out set is the real
 * drafts in claimDraftRealSet.ts.
 */

import type { ClaimDraftLabelV1, ClaimDraftSourceV1 } from "./claimDraftEvalSet";

export type ClaimDraftTrapV2 = "source_list" | "bibliography" | "quote_note" | "aside" | "beside";

export interface ClaimDraftEvalCaseV2 {
  id: string;
  split: "calibration" | "heldout";
  family: "source_lists" | "real_draft";
  prompt: string;
  render: "tokens" | "footnotes";
  sources: ClaimDraftSourceV1[];
  draft: string;
  labels: Array<{ match: string; label: ClaimDraftLabelV1; trap?: ClaimDraftTrapV2 }>;
}

function source(sourceId: string, title: string, url: string, texts: string[]): ClaimDraftSourceV1 {
  let offset = 0;
  const passages = texts.map((text) => {
    const id = `source:${sourceId}:passage:${offset}-${offset + text.length}`;
    offset += text.length + 40;
    return { id, text };
  });
  return { sourceId, title, url, passages };
}

const c = (s: ClaimDraftSourceV1, index: number) => `[${s.passages[index]!.id}]`;
const tick = (s: ClaimDraftSourceV1, index: number) => `\`${s.passages[index]!.id}\``;

const heatTrial = source("c11a01", "Field trial of cold-climate heat pumps", "https://example.org/nel/heat-pump-trial", [
  "Every cold-climate heat pump in the trial kept heating the home through a week of outdoor temperatures near -15 °C.",
  "Measured efficiency fell from a coefficient of performance of about 3.0 at 5 °C to about 2.0 at -15 °C.",
  "Households in the trial paid on average 18% less for heating than in the year before, when they used oil boilers.",
]);

const calSourcesHeading: ClaimDraftEvalCaseV2 = {
  id: "s-cal-sources-heading",
  split: "calibration",
  family: "source_lists",
  prompt: "Research cold-climate heat pumps on the web and append a short sourced summary with passage citations.",
  render: "tokens",
  sources: [heatTrial],
  draft: [
    "# Heat pumps in cold climates",
    "",
    "## Findings",
    "",
    `Cold-climate heat pumps kept heating homes through a week near -15 °C in the field trial ${c(heatTrial, 0)}.`,
    `Their efficiency fell by about a third between 5 °C and -15 °C ${c(heatTrial, 1)}.`,
    `Heat pumps stopped heating below -5 °C in most of the homes studied ${c(heatTrial, 0)}.`,
    `Heating bills in the trial homes fell by nearly half compared with oil ${c(heatTrial, 2)}.`,
    "",
    "## Sources",
    "",
    `- Northern Energy Lab, "Field trial of cold-climate heat pumps", 2023 — https://example.org/nel/heat-pump-trial ${c(heatTrial, 0)}`,
    "- Retrieved on 2026-10-20 from the lab's site; the trial summary and its results table were read.",
    "",
    "## References and tiers",
    "",
    "1. Field trial report (tier 1, the lab's own publication of its measurements).",
  ].join("\n"),
  labels: [
    { match: "kept heating homes through a week near", label: "supported" },
    { match: "fell by about a third between 5", label: "supported" },
    { match: "stopped heating below -5 °C", label: "contradicted" },
    { match: "fell by nearly half compared with oil", label: "contradicted" },
    { match: "Northern Energy Lab, \"Field trial", label: "process", trap: "bibliography" },
    { match: "Retrieved on 2026-10-20 from the lab", label: "process", trap: "source_list" },
    { match: "Field trial report (tier 1", label: "process", trap: "source_list" },
  ],
};

const canopySurvey = source("c22b02", "Street trees and surface heat: municipal survey", "https://example.org/urban-heat/survey", [
  "Street trees lowered midday surface temperatures of pavements by up to 12 °C in the survey's sampled blocks.",
  "The city's canopy cover rose from 18% in 2010 to 21% in 2020, short of its 25% target.",
]);
const canopyPlan = source("c22b03", "Canopy targets", "https://example.gov/canopy", [
  "The canopy plan sets a target of 30% cover by 2035 and funds 20,000 new street trees.",
]);

const calBoldLabel: ClaimDraftEvalCaseV2 = {
  id: "s-cal-bold-label",
  split: "calibration",
  family: "source_lists",
  prompt: "Research street trees and urban heat on the web using two sources and append a summary with passage citations.",
  render: "tokens",
  sources: [canopySurvey, canopyPlan],
  draft: [
    "# Urban trees and heat",
    "",
    `Street trees lowered midday pavement temperatures by up to 12 °C in the city's survey ${c(canopySurvey, 0)}.`,
    `The city plans 20,000 new street trees toward a target of 30% canopy cover by 2035 ${c(canopyPlan, 0)}.`,
    "",
    "**Sources fetched (2026-10-20), two distinct domains:**",
    `- https://example.org/urban-heat/survey — the municipal survey of street-tree cooling, 2022 ${c(canopySurvey, 0)}`,
    "- City Climate Office, \"Canopy targets\", policy page — https://example.gov/canopy",
    "",
    `Canopy cover in the city rose from 18% to 25% between 2010 and 2020 ${c(canopySurvey, 1)}.`,
    `A citywide survey (https://example.org/urban-heat/survey) found that trees cooled pavements by more than 20 °C ${c(canopySurvey, 0)}.`,
    "",
    "Sources consulted on 2026-10-20, two URLs across two host domains, cited above.",
  ].join("\n"),
  labels: [
    { match: "lowered midday pavement temperatures by up to 12", label: "supported" },
    { match: "plans 20,000 new street trees toward", label: "supported" },
    { match: "Sources fetched (2026-10-20), two distinct", label: "process", trap: "source_list" },
    { match: "the municipal survey of street-tree cooling, 2022", label: "process", trap: "bibliography" },
    { match: "City Climate Office, \"Canopy targets\", policy", label: "process", trap: "bibliography" },
    { match: "rose from 18% to 25% between 2010", label: "contradicted", trap: "beside" },
    { match: "found that trees cooled pavements by more than 20", label: "contradicted", trap: "beside" },
    { match: "Sources consulted on 2026-10-20, two URLs", label: "process", trap: "source_list" },
  ],
};

const sleepStudy = source("c33c04", "Sleep after learning and next-day recall", "https://example.org/sleep/recall", [
  "Participants who slept after learning recalled 20% more word pairs the next day than those who stayed awake.",
  "In the 2019 nap trial, a 60-minute nap after learning modestly improved recall of word pairs compared with rest.",
]);

const calQuoteNotes: ClaimDraftEvalCaseV2 = {
  id: "s-cal-quote-notes",
  split: "calibration",
  family: "source_lists",
  prompt: "Research sleep and memory on the web and append a summary with quotations and passage citations.",
  render: "tokens",
  sources: [sleepStudy],
  draft: [
    "# Sleep and memory",
    "",
    "Passage ids are copied verbatim from the fetched pages; only bounded reads were made.",
    "",
    `- Sleep after learning improved next-day recall of word pairs ${tick(sleepStudy, 0)}`,
    `- "Participants who slept after learning recalled 20% more word pairs the next day than those who stayed awake." ${tick(sleepStudy, 0)}`,
    `- Quotations from the 2019 trial show that naps had no effect on recall ${tick(sleepStudy, 1)}`,
    `- Sleeping after learning doubled recall of word pairs ${tick(sleepStudy, 0)}`,
    "",
    "All quoted fragments now appear verbatim in the cited passages, and earlier paraphrases were left unquoted.",
    "",
    "*Note: quotations above are copied verbatim from the cached source passages; no wording was changed.*",
  ].join("\n"),
  labels: [
    { match: "Passage ids are copied verbatim from the fetched", label: "process", trap: "quote_note" },
    { match: "Sleep after learning improved next-day recall", label: "supported" },
    { match: "recalled 20% more word pairs the next day than those", label: "supported" },
    { match: "Quotations from the 2019 trial show that naps", label: "contradicted", trap: "beside" },
    { match: "Sleeping after learning doubled recall", label: "contradicted" },
    { match: "All quoted fragments now appear verbatim", label: "process", trap: "quote_note" },
    { match: "quotations above are copied verbatim from the cached", label: "process", trap: "quote_note" },
  ],
};

const reefReport = source("c44d05", "Fourth global coral bleaching event", "https://example.org/reefs/bleaching-2024", [
  "The fourth global bleaching event, confirmed in 2024, affected coral reefs in at least 62 countries and territories.",
  "About 77% of the world's reef area experienced bleaching-level heat stress between January 2023 and late 2024.",
]);

const calAsides: ClaimDraftEvalCaseV2 = {
  id: "s-cal-asides",
  split: "calibration",
  family: "source_lists",
  prompt: "Research the 2024 coral bleaching event on the web and append a summary with passage citations to this note.",
  render: "tokens",
  sources: [reefReport],
  draft: [
    "Here is the complete corrected note content:",
    "",
    "# Coral bleaching in 2024",
    "",
    `The 2024 global bleaching event affected reefs in at least 62 countries and territories ${c(reefReport, 0)}.`,
    `About three quarters of the world's reef area saw bleaching-level heat stress from 2023 to late 2024 ${c(reefReport, 1)}.`,
    `Here is why the scale matters: reefs bleached this widely usually recover fully within two years ${c(reefReport, 1)}.`,
    `Bleaching affected reefs in fewer than 20 countries during the event ${c(reefReport, 0)}.`,
    "",
    "Below is the summary in its final form, ready to paste under the note's heading.",
    "I've revised the note so that every quotation carries its passage citation.",
  ].join("\n"),
  labels: [
    { match: "Here is the complete corrected note content", label: "process", trap: "aside" },
    { match: "affected reefs in at least 62 countries", label: "supported" },
    { match: "About three quarters of the world's reef area", label: "supported" },
    { match: "reefs bleached this widely usually recover fully", label: "insufficient", trap: "beside" },
    { match: "in fewer than 20 countries during the event", label: "contradicted" },
    { match: "Below is the summary in its final form", label: "process", trap: "aside" },
    { match: "I've revised the note so that every quotation", label: "process", trap: "aside" },
  ],
};

export const CLAIM_DRAFT_SOURCE_LIST_SET_V2: readonly ClaimDraftEvalCaseV2[] = [
  calSourcesHeading,
  calBoldLabel,
  calQuoteNotes,
  calAsides,
];
