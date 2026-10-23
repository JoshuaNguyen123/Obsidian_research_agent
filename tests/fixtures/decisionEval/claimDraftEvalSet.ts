/**
 * Labeled research drafts for the end-to-end claim-support evaluation (JEV-5).
 *
 * `claimSupportEvalSet.ts` judges claim/passage pairs that are already bound.
 * Real drafts fail earlier than that: a sentence has to be extracted, bound to
 * the right passages, and judged eligible before the decision model ever sees
 * it. D-135 found three ways that goes wrong on live drafts:
 *
 * - citations are rendered as one footnote per *source*, so a sentence loses
 *   its own passage id and is soft-bound to every passage it shares a word
 *   with, which pushes it past the per-claim passage limit (unassessed);
 * - a process sentence ("Could not verify: …") outside a Limitations heading
 *   can be soft-bound to passages and then held as unsupported;
 * - every sentence under a Limitations heading, or carrying a word such as
 *   "confidence", is exempt, so a cited factual claim there is never checked.
 *
 * Each case is a whole draft written the way the runner's drafts are written:
 * passage tokens inline, optionally rendered to footnotes by the production
 * renderer (`renderCitedNoteBodyV1`) exactly as the write path does before the
 * check. Every material sentence carries a label, written before any candidate
 * code existed and frozen with this file's hash:
 *
 * - supported / contradicted / insufficient: a factual claim, judged only
 *   against the passages its author cited (or, uncited, the source it draws on);
 * - process: a statement about the research or the note itself (what was
 *   searched, what could not be verified). It must never be held.
 *
 * `split` is frozen per case. Calibration may tune; held-out is scored once
 * per arm with the frozen code.
 */

export type ClaimDraftLabelV1 = "supported" | "contradicted" | "insufficient" | "process";

export interface ClaimDraftSentenceLabelV1 {
  /** A substring that identifies exactly one sentence of the draft. */
  match: string;
  label: ClaimDraftLabelV1;
  /** Why the sentence is a trap, for the report. */
  trap?:
    | "footnote"
    | "multi_citation"
    | "limitations_cited"
    | "limitations_process"
    | "keyword_exempt"
    | "process_outside"
    | "process_with_subject"
    | "screening"
    | "figure"
    | "transcript";
}

export interface ClaimDraftSourceV1 {
  sourceId: string;
  title: string;
  url: string;
  passages: Array<{ id: string; text: string }>;
}

export interface ClaimDraftEvalCaseV1 {
  id: string;
  split: "calibration" | "heldout";
  family: "footnote_draft" | "multi_citation" | "limitations" | "screening" | "media";
  prompt: string;
  /** Rendered to footnotes by the production renderer before the check. */
  render: "tokens" | "footnotes";
  sources: ClaimDraftSourceV1[];
  /** Written with passage tokens; `render` decides what the check sees. */
  draft: string;
  labels: ClaimDraftSentenceLabelV1[];
}

/** A passage token for a source, at a character offset. */
function passage(sourceId: string, start: number, text: string): { id: string; text: string } {
  return { id: `source:${sourceId}:passage:${start}-${start + text.length}`, text };
}

function source(sourceId: string, title: string, url: string, texts: string[]): ClaimDraftSourceV1 {
  let offset = 0;
  const passages = texts.map((text) => {
    const made = passage(sourceId, offset, text);
    offset += text.length + 40;
    return made;
  });
  return { sourceId, title, url, passages };
}

const c = (s: ClaimDraftSourceV1, index: number) => `[${s.passages[index]!.id}]`;

/* ---------------------------------------------------------------------- */
/* Calibration                                                             */
/* ---------------------------------------------------------------------- */

const fdwPilot = source("a41d07", "The results are in: the UK's four-day week pilot", "https://autonomy.work/portfolio/uk4dwpilotresults/", [
  "The pilot ran for six months, from June to December 2022, across 61 companies employing around 2,900 people in the United Kingdom.",
  "Of the participating companies, 56 said they would continue with the four-day week after the trial ended, and 18 said the policy was permanent.",
  "Company revenue stayed broadly the same over the trial period, rising 1.4% on average for the 23 organisations that provided adequate data.",
  "Staff sickness days fell by about two-thirds, and 39% of employees said they were less stressed at the end of the trial.",
  "The number of staff leaving participating companies fell by 57% over the trial period compared with the same period a year earlier.",
]);
const fdwReview = source("b72e11", "Four-day week trials: a review of the evidence", "https://example.org/reviews/four-day-week", [
  "Most four-day week trials to date have been run in office-based, knowledge-work firms that volunteered to take part.",
  "Because companies opted in, the trials cannot show whether a firm chosen at random would see the same results.",
]);

const calFootnote: ClaimDraftEvalCaseV1 = {
  id: "d-cal-fdw",
  split: "calibration",
  family: "footnote_draft",
  prompt: "Write a sourced note on the UK four-day week pilot and what it found.",
  render: "footnotes",
  sources: [fdwPilot, fdwReview],
  draft: [
    "# The UK four-day week pilot",
    "",
    "## Findings",
    "",
    `The UK pilot ran for six months across 61 companies with about 2,900 employees ${c(fdwPilot, 0)}.`,
    `Most companies kept the policy afterwards, with 56 of the 61 continuing the four-day week ${c(fdwPilot, 1)}.`,
    `Revenue was broadly unchanged, rising 1.4% on average among the firms that reported data ${c(fdwPilot, 2)}.`,
    `Sickness days fell by about two-thirds over the trial ${c(fdwPilot, 3)}.`,
    `Staff turnover dropped by 57% compared with the previous year ${c(fdwPilot, 4)}.`,
    `Productivity rose by 25% at every participating company ${c(fdwPilot, 2)}.`,
    `The trial ran for a full year before the results were published ${c(fdwPilot, 0)}.`,
    "Could not verify: the widely shared claim that 92% of employees wanted to keep the policy.",
    "",
    "## Limitations",
    "",
    `The participating firms volunteered, so the results may not hold for a firm chosen at random ${c(fdwReview, 1)}.`,
    `Every participating company was a manufacturing firm ${c(fdwReview, 0)}.`,
    "I searched for peer-reviewed follow-ups and found none published yet.",
    "This note relies only on the pilot's own report and one review.",
  ].join("\n"),
  labels: [
    { match: "ran for six months across 61 companies", label: "supported", trap: "footnote" },
    { match: "56 of the 61 continuing", label: "supported", trap: "footnote" },
    { match: "rising 1.4% on average", label: "supported", trap: "footnote" },
    { match: "Sickness days fell by about two-thirds", label: "supported", trap: "footnote" },
    { match: "Staff turnover dropped by 57%", label: "supported", trap: "footnote" },
    { match: "Productivity rose by 25% at every", label: "insufficient", trap: "footnote" },
    { match: "ran for a full year before", label: "contradicted", trap: "footnote" },
    { match: "Could not verify: the widely shared claim", label: "process", trap: "process_outside" },
    { match: "volunteered, so the results may not hold", label: "supported", trap: "limitations_cited" },
    { match: "Every participating company was a manufacturing firm", label: "contradicted", trap: "limitations_cited" },
    { match: "I searched for peer-reviewed follow-ups", label: "process", trap: "limitations_process" },
    { match: "This note relies only on", label: "process", trap: "limitations_process" },
  ],
};

const sleepA = source("c90f32", "Sleep and memory consolidation", "https://example.org/sleep/memory-review", [
  "Slow-wave sleep is associated with the consolidation of declarative memories, such as facts and word lists, learned before sleep.",
  "In the reviewed studies, participants who slept after learning recalled more word pairs the next morning than participants who stayed awake for the same interval.",
  "The effect of sleep on procedural skills, such as finger-tapping sequences, was smaller and less consistent across laboratories.",
]);
const sleepB = source("c90f99", "Sleep deprivation and recall: a meta-analysis", "https://example.org/sleep/meta-analysis", [
  "Across 31 experiments, a night of total sleep deprivation before learning reduced later recall by a moderate amount (pooled effect size 0.62).",
  "The authors rated the certainty of the pooled estimate as moderate, because most experiments enrolled fewer than 40 young adults.",
]);

const calMulti: ClaimDraftEvalCaseV1 = {
  id: "d-cal-sleep",
  split: "calibration",
  family: "multi_citation",
  prompt: "Summarize what the research says about sleep and memory, with citations.",
  render: "tokens",
  sources: [sleepA, sleepB],
  draft: [
    "# Sleep and memory",
    "",
    `Sleeping after learning improves next-day recall of word pairs, and slow-wave sleep is linked to consolidating facts ${c(sleepA, 0)} ${c(sleepA, 1)}.`,
    `Losing a whole night of sleep before learning reduces later recall, an effect seen across 31 experiments ${c(sleepB, 0)} ${c(sleepA, 1)}.`,
    `Sleep helps procedural skills just as strongly as it helps word lists ${c(sleepA, 2)} ${c(sleepA, 0)}.`,
    `The meta-analysis authors had high confidence in the pooled estimate ${c(sleepB, 1)}.`,
    `Most experiments in the meta-analysis enrolled fewer than 40 young adults ${c(sleepB, 1)}.`,
    `Sleep deprivation permanently damages long-term memory ${c(sleepB, 0)} ${c(sleepB, 1)} ${c(sleepA, 1)} ${c(sleepA, 2)}.`,
    "",
    "## Open questions",
    "",
    "Whether naps produce the same benefit is unclear from the sources gathered.",
    `Two of the reviewed laboratories could not reproduce the procedural-skill effect ${c(sleepA, 2)}.`,
  ].join("\n"),
  labels: [
    { match: "Sleeping after learning improves next-day recall", label: "supported", trap: "multi_citation" },
    { match: "Losing a whole night of sleep before learning", label: "supported", trap: "multi_citation" },
    { match: "procedural skills just as strongly", label: "contradicted", trap: "multi_citation" },
    { match: "had high confidence in the pooled estimate", label: "contradicted", trap: "keyword_exempt" },
    { match: "enrolled fewer than 40 young adults", label: "supported" },
    { match: "permanently damages long-term memory", label: "insufficient", trap: "multi_citation" },
    { match: "Whether naps produce the same benefit", label: "process", trap: "limitations_process" },
    { match: "could not reproduce the procedural-skill effect", label: "insufficient", trap: "process_with_subject" },
  ],
};

const heatA = source("d13a55", "Heat pumps in cold climates", "https://example.org/energy/cold-climate-heat-pumps", [
  "Field monitoring of 240 homes in Norway, Sweden and Finland found air-source heat pumps kept running at outdoor temperatures down to -25 °C.",
  "Below -15 °C the pumps' efficiency fell, with a seasonal coefficient of performance around 2.0 compared with about 3.0 over a whole winter.",
  "Heat pumps made up about 60% of new heating installations in Norway in 2022.",
]);
const heatB = source("d13a88", "Installer survey on heat pump adoption", "https://example.org/energy/installer-survey", [
  "In a survey of 410 installers, the most common reason customers gave for not buying a heat pump was the upfront cost.",
]);

const calLimits: ClaimDraftEvalCaseV1 = {
  id: "d-cal-heat",
  split: "calibration",
  family: "limitations",
  prompt: "Do heat pumps work in very cold climates? Write it up with sources.",
  render: "tokens",
  sources: [heatA, heatB],
  draft: [
    "# Heat pumps in cold climates",
    "",
    `Monitored air-source heat pumps in Nordic homes kept working at outdoor temperatures as low as -25 °C ${c(heatA, 0)}.`,
    `Their efficiency drops in deep cold, to a coefficient of performance of about 2.0 below -15 °C ${c(heatA, 1)}.`,
    `In Norway, heat pumps accounted for roughly 60% of new heating installations in 2022 ${c(heatA, 2)}.`,
    `Heat pumps stop working entirely below -10 °C ${c(heatA, 0)}.`,
    `Installers said customers' main objection was the noise of the outdoor unit ${c(heatB, 0)}.`,
    "Not independently verified: the manufacturer's figure of 40% lower bills.",
    "",
    "## Limitations",
    "",
    `The field data cover 240 homes in three Nordic countries ${c(heatA, 0)}.`,
    `Confidence in the efficiency figures is high because every home was monitored for five years ${c(heatA, 1)}.`,
    "Evidence from North American homes was not found in the sources reviewed.",
    "Uncertainty remains about installation quality, which the sources did not measure.",
  ].join("\n"),
  labels: [
    { match: "kept working at outdoor temperatures as low as -25", label: "supported" },
    { match: "coefficient of performance of about 2.0 below", label: "supported" },
    { match: "roughly 60% of new heating installations", label: "supported" },
    { match: "stop working entirely below -10", label: "contradicted" },
    { match: "main objection was the noise", label: "contradicted" },
    { match: "Not independently verified: the manufacturer", label: "process", trap: "process_outside" },
    { match: "cover 240 homes in three Nordic countries", label: "supported", trap: "limitations_cited" },
    { match: "monitored for five years", label: "insufficient", trap: "limitations_cited" },
    { match: "Evidence from North American homes was not found", label: "process", trap: "limitations_process" },
    { match: "Uncertainty remains about installation quality", label: "process", trap: "limitations_process" },
  ],
};

const mindReview = source("e55b20", "Mindfulness apps for anxiety: screening log", "https://example.org/reviews/mindfulness-apps/screening", [
  "The database searches returned 412 records; after removing 97 duplicates, 315 titles and abstracts were screened.",
  "Of the 315 screened records, 41 were assessed in full text and 12 randomized controlled trials met the inclusion criteria.",
  "The most common reason for exclusion at full text was the absence of a control group (17 of 29 exclusions).",
]);
const mindTrial = source("e55c31", "A randomized trial of a mindfulness app for anxiety", "https://example.org/trials/mindfulness-app-rct", [
  "Participants using the app for eight weeks reported a small reduction in anxiety scores compared with a waitlist control.",
  "Adherence fell over time: 61% of participants were still using the app in week four and 38% in week eight.",
]);

const calScreening: ClaimDraftEvalCaseV1 = {
  id: "d-cal-mind",
  split: "calibration",
  family: "screening",
  prompt: "Screen the literature on mindfulness apps for anxiety and summarize the included trials.",
  render: "tokens",
  sources: [mindReview, mindTrial],
  draft: [
    "# Mindfulness apps for anxiety",
    "",
    "## Screening",
    "",
    `After duplicates were removed, 315 records were screened by title and abstract ${c(mindReview, 0)}.`,
    `Twelve randomized controlled trials met the inclusion criteria after 41 full-text assessments ${c(mindReview, 1)}.`,
    `Lack of a control group was the most frequent full-text exclusion reason ${c(mindReview, 2)}.`,
    `Twenty trials were included in the final synthesis ${c(mindReview, 1)}.`,
    "I screened titles and abstracts against the inclusion criteria before reading full texts.",
    "",
    "## Included trials",
    "",
    `Eight weeks of app use gave a small reduction in anxiety compared with a waitlist ${c(mindTrial, 0)}.`,
    `Adherence declined, with only 38% still using the app by week eight ${c(mindTrial, 1)}.`,
    `The app cured anxiety disorders in most participants ${c(mindTrial, 0)}.`,
  ].join("\n"),
  labels: [
    { match: "315 records were screened", label: "supported", trap: "screening" },
    { match: "Twelve randomized controlled trials met", label: "supported", trap: "screening" },
    { match: "Lack of a control group was the most frequent", label: "supported", trap: "screening" },
    { match: "Twenty trials were included", label: "contradicted", trap: "screening" },
    { match: "I screened titles and abstracts", label: "process", trap: "process_outside" },
    { match: "small reduction in anxiety compared with a waitlist", label: "supported" },
    { match: "only 38% still using the app", label: "supported" },
    { match: "cured anxiety disorders in most", label: "insufficient" },
  ],
};

const evChart = source("f2c401", "Global EV Outlook 2024, Figure 1.1 (chart text)", "https://example.org/iea/global-ev-outlook-2024#figure-1-1", [
  "Figure 1.1 Electric car sales, 2018-2023. Annual sales rose from about 2 million in 2018 to almost 14 million in 2023. China accounted for about 60% of 2023 sales, Europe for about 25% and the United States for about 10%.",
  "Figure 1.2 Share of electric cars in total car sales, 2023: Norway 93%, Sweden 60%, China 38%, Europe 21%, United States 10%.",
]);
const evTalk = source("f2c477", "Transcript: EV battery prices panel, 12:40-14:10", "https://example.org/videos/ev-battery-panel#t=760", [
  "[12:40] Battery pack prices fell by about 14% in 2023, to around 139 dollars per kilowatt-hour, according to the analyst.",
  "[13:25] The panel said lower lithium prices drove most of the decline, while manufacturing scale explained the rest.",
]);

const calMedia: ClaimDraftEvalCaseV1 = {
  id: "d-cal-ev",
  split: "calibration",
  family: "media",
  prompt: "What do the IEA charts and the battery panel video say about electric car growth?",
  render: "footnotes",
  sources: [evChart, evTalk],
  draft: [
    "# Electric car growth",
    "",
    `Figure 1.1 shows annual electric car sales rising to almost 14 million in 2023 ${c(evChart, 0)}.`,
    `China made up about 60% of electric car sales in 2023, according to the same chart ${c(evChart, 0)}.`,
    `Electric cars were 93% of new car sales in Norway in 2023 ${c(evChart, 1)}.`,
    `In the United States, electric cars passed half of all new sales in 2023 ${c(evChart, 1)}.`,
    `At 12:40 in the panel, the analyst says pack prices fell about 14% in 2023 ${c(evTalk, 0)}.`,
    `The panel attributes most of the price fall to new battery chemistry ${c(evTalk, 1)}.`,
    "The chart values were read from the figure's text layer, not measured from the image.",
  ].join("\n"),
  labels: [
    { match: "rising to almost 14 million in 2023", label: "supported", trap: "figure" },
    { match: "China made up about 60%", label: "supported", trap: "figure" },
    { match: "93% of new car sales in Norway", label: "supported", trap: "figure" },
    { match: "passed half of all new sales", label: "contradicted", trap: "figure" },
    { match: "pack prices fell about 14%", label: "supported", trap: "transcript" },
    { match: "most of the price fall to new battery chemistry", label: "contradicted", trap: "transcript" },
    { match: "read from the figure's text layer", label: "process", trap: "process_outside" },
  ],
};

const treeA = source("a77e10", "Urban tree canopy and summer temperatures", "https://example.org/urban/tree-canopy-heat", [
  "Across 293 European cities, areas with tree cover were on average 1.3 °C cooler on summer days than nearby areas without trees.",
  "The cooling effect was largest in cities in central Europe and smallest in Mediterranean cities with dry summers.",
  "Modelling suggested that raising tree cover to 30% could have prevented about a third of deaths attributed to urban heat in summer 2015.",
]);
const treeB = source("a77e44", "Street trees and pavement temperature", "https://example.org/urban/street-trees-surface", [
  "Shaded pavement under street trees was measured up to 20 °C cooler at midday than pavement in direct sun.",
]);

const calTrees: ClaimDraftEvalCaseV1 = {
  id: "d-cal-trees",
  split: "calibration",
  family: "footnote_draft",
  prompt: "Write a note on how much urban trees cool cities, with sources.",
  render: "footnotes",
  sources: [treeA, treeB],
  draft: [
    "# Urban trees and heat",
    "",
    `Tree-covered areas in European cities averaged 1.3 °C cooler on summer days ${c(treeA, 0)}.`,
    `The cooling was strongest in central European cities ${c(treeA, 1)}.`,
    `Raising canopy to 30% could have prevented about a third of summer heat deaths in 2015, according to modelling ${c(treeA, 2)}.`,
    `Mediterranean cities showed the largest cooling from trees ${c(treeA, 1)}.`,
    `Pavement in tree shade can be up to 20 °C cooler at midday ${c(treeB, 0)}.`,
    `Planting trees lowers city air temperatures by 10 °C on average ${c(treeA, 0)}.`,
    "Further research is needed on how drought affects these benefits.",
  ].join("\n"),
  labels: [
    { match: "averaged 1.3 °C cooler", label: "supported", trap: "footnote" },
    { match: "strongest in central European cities", label: "supported", trap: "footnote" },
    { match: "about a third of summer heat deaths", label: "supported", trap: "footnote" },
    { match: "Mediterranean cities showed the largest cooling", label: "contradicted", trap: "footnote" },
    { match: "up to 20 °C cooler at midday", label: "supported", trap: "footnote" },
    { match: "lowers city air temperatures by 10", label: "contradicted", trap: "footnote" },
    { match: "Further research is needed on how drought", label: "process", trap: "limitations_process" },
  ],
};

/* ---------------------------------------------------------------------- */
/* Held-out                                                                */
/* ---------------------------------------------------------------------- */

const microA = source("b19d02", "Microplastics in drinking water", "https://example.org/water/microplastics-who", [
  "Microplastics have been detected in tap water and bottled water, with reported concentrations ranging from zero to thousands of particles per litre.",
  "Based on the limited information available, microplastics in drinking water do not appear to pose a health risk at current levels.",
  "Conventional drinking-water treatment that includes coagulation and filtration removes more than 90% of particles larger than a few micrometres.",
  "Most studies used different sampling and analysis methods, which makes their results hard to compare.",
]);
const microB = source("b19d77", "Nanoplastics in bottled water", "https://example.org/water/nanoplastics-bottled", [
  "Using stimulated Raman scattering imaging, researchers counted about 240,000 plastic particles per litre in bottled water from three brands, about 90% of them nanoplastics.",
]);

const hoMicro: ClaimDraftEvalCaseV1 = {
  id: "d-ho-micro",
  split: "heldout",
  family: "footnote_draft",
  prompt: "Research microplastics in drinking water and write a sourced note.",
  render: "footnotes",
  sources: [microA, microB],
  draft: [
    "# Microplastics in drinking water",
    "",
    `Microplastics have been found in both tap and bottled water ${c(microA, 0)}.`,
    `Reported concentrations vary widely, from none to thousands of particles per litre ${c(microA, 0)}.`,
    `Current evidence does not show a health risk from microplastics in drinking water at today's levels ${c(microA, 1)}.`,
    `Standard treatment with coagulation and filtration removes over 90% of larger particles ${c(microA, 2)}.`,
    `One study counted about 240,000 particles per litre in bottled water, most of them nanoplastics ${c(microB, 0)}.`,
    `Microplastics in tap water have been proven to cause cancer ${c(microA, 1)}.`,
    `Boiling tap water removes all microplastics ${c(microA, 2)}.`,
    "Could not verify: the figure of five grams of plastic swallowed per week that is often quoted online.",
    "",
    "## Limitations",
    "",
    `Studies used different sampling and analysis methods, so their results are hard to compare ${c(microA, 3)}.`,
    `All of the studies measured water from the same three cities ${c(microA, 3)}.`,
    "I did not find any long-term human exposure study in the sources gathered.",
    "This summary covers drinking water only, not food or air.",
  ].join("\n"),
  labels: [
    { match: "found in both tap and bottled water", label: "supported", trap: "footnote" },
    { match: "from none to thousands of particles", label: "supported", trap: "footnote" },
    { match: "does not show a health risk", label: "supported", trap: "footnote" },
    { match: "removes over 90% of larger particles", label: "supported", trap: "footnote" },
    { match: "about 240,000 particles per litre", label: "supported", trap: "footnote" },
    { match: "proven to cause cancer", label: "contradicted", trap: "footnote" },
    { match: "Boiling tap water removes all microplastics", label: "insufficient", trap: "footnote" },
    { match: "Could not verify: the figure of five grams", label: "process", trap: "process_outside" },
    { match: "different sampling and analysis methods, so", label: "supported", trap: "limitations_cited" },
    { match: "same three cities", label: "insufficient", trap: "limitations_cited" },
    { match: "I did not find any long-term human exposure", label: "process", trap: "limitations_process" },
    { match: "This summary covers drinking water only", label: "process", trap: "limitations_process" },
  ],
};

const fastA = source("c33e01", "Intermittent fasting versus daily calorie restriction", "https://example.org/nutrition/if-vs-cr-trial", [
  "In a 12-month randomized trial of 139 adults with obesity, time-restricted eating plus calorie restriction produced weight loss similar to calorie restriction alone.",
  "Mean weight loss was 8.0 kg in the time-restricted group and 6.3 kg in the daily calorie restriction group, a difference that was not statistically significant.",
  "Adverse events were similar between the groups, and most were mild, such as fatigue and headache.",
]);
const fastB = source("c33e60", "Alternate-day fasting and cardiometabolic markers", "https://example.org/nutrition/adf-markers", [
  "After six months, alternate-day fasting did not improve LDL cholesterol more than daily calorie restriction.",
  "Dropout was higher in the alternate-day fasting group (38%) than in the daily restriction group (29%).",
]);

const hoFasting: ClaimDraftEvalCaseV1 = {
  id: "d-ho-fasting",
  split: "heldout",
  family: "multi_citation",
  prompt: "Is intermittent fasting better than ordinary calorie restriction for weight loss? Cite the trials.",
  render: "tokens",
  sources: [fastA, fastB],
  draft: [
    "# Intermittent fasting versus calorie restriction",
    "",
    `Over a year, time-restricted eating with calorie restriction led to weight loss similar to calorie restriction alone, 8.0 kg against 6.3 kg with no significant difference ${c(fastA, 0)} ${c(fastA, 1)}.`,
    `Neither alternate-day fasting nor time-restricted eating clearly beat daily calorie restriction on the outcomes measured ${c(fastA, 0)} ${c(fastB, 0)}.`,
    `Alternate-day fasting lowered LDL cholesterol far more than daily restriction ${c(fastB, 0)} ${c(fastA, 1)}.`,
    `Side effects were similar between groups and mostly mild ${c(fastA, 2)}.`,
    `More people dropped out of alternate-day fasting than of daily restriction ${c(fastB, 1)} ${c(fastA, 2)} ${c(fastB, 0)}.`,
    `Intermittent fasting doubles weight loss compared with any other diet ${c(fastA, 0)} ${c(fastA, 1)} ${c(fastA, 2)} ${c(fastB, 0)}.`,
    `Fasting trials show high confidence that metabolism speeds up during a fast ${c(fastB, 0)}.`,
    "",
    "## Limitations",
    "",
    `The main trial enrolled only 139 adults ${c(fastA, 0)}.`,
    `Every participant in the trial was over 65 years old ${c(fastA, 0)}.`,
    "The evidence is limited to trials lasting a year or less.",
  ].join("\n"),
  labels: [
    { match: "8.0 kg against 6.3 kg", label: "supported", trap: "multi_citation" },
    { match: "Neither alternate-day fasting nor time-restricted", label: "supported", trap: "multi_citation" },
    { match: "lowered LDL cholesterol far more", label: "contradicted", trap: "multi_citation" },
    { match: "Side effects were similar between groups", label: "supported" },
    { match: "More people dropped out of alternate-day", label: "supported", trap: "multi_citation" },
    { match: "doubles weight loss compared with any other", label: "contradicted", trap: "multi_citation" },
    { match: "high confidence that metabolism speeds up", label: "insufficient", trap: "keyword_exempt" },
    { match: "enrolled only 139 adults", label: "supported", trap: "limitations_cited" },
    { match: "Every participant in the trial was over 65", label: "insufficient", trap: "limitations_cited" },
    { match: "evidence is limited to trials lasting", label: "process", trap: "limitations_process" },
  ],
};

const remoteA = source("d81f04", "Working from home and productivity: a randomized experiment", "https://example.org/work/wfh-rct", [
  "In a six-month experiment at a Chinese travel agency, hybrid work (two days at home per week) did not change performance reviews or promotion rates.",
  "Quit rates fell by one third among employees on the hybrid schedule, with the largest falls among non-managers, women and employees with long commutes.",
  "Managers initially expected hybrid work to lower productivity, but by the end of the experiment their views had become more positive.",
]);
const remoteB = source("d81f50", "Fully remote work and output in a data-entry firm", "https://example.org/work/fully-remote-data-entry", [
  "Workers randomly assigned to fully remote data entry were 18% less productive than those in the office, according to keystroke-based output measures.",
]);

const hoRemote: ClaimDraftEvalCaseV1 = {
  id: "d-ho-remote",
  split: "heldout",
  family: "footnote_draft",
  prompt: "Does working from home hurt productivity? Summarize the experiments with sources.",
  render: "footnotes",
  sources: [remoteA, remoteB],
  draft: [
    "# Remote work and productivity",
    "",
    `In a six-month randomized experiment, two days a week at home did not change performance reviews or promotions ${c(remoteA, 0)}.`,
    `The hybrid schedule cut quit rates by a third ${c(remoteA, 1)}.`,
    `Managers' views of hybrid work grew more positive over the experiment ${c(remoteA, 2)}.`,
    `In a separate data-entry experiment, fully remote workers were 18% less productive ${c(remoteB, 0)}.`,
    `Hybrid work raised promotion rates for every employee group ${c(remoteA, 0)}.`,
    `Quit rates fell most among managers ${c(remoteA, 1)}.`,
    "No study comparing fully remote and hybrid work in the same firm was found during this research.",
    "",
    "## Limitations",
    "",
    `The hybrid experiment took place in a single Chinese travel agency ${c(remoteA, 0)}.`,
    `Results from the data-entry firm were later retracted ${c(remoteB, 0)}.`,
    "These findings may vary by industry and job type.",
  ].join("\n"),
  labels: [
    { match: "did not change performance reviews or promotions", label: "supported", trap: "footnote" },
    { match: "cut quit rates by a third", label: "supported", trap: "footnote" },
    { match: "views of hybrid work grew more positive", label: "supported", trap: "footnote" },
    { match: "18% less productive", label: "supported", trap: "footnote" },
    { match: "raised promotion rates for every employee group", label: "contradicted", trap: "footnote" },
    { match: "Quit rates fell most among managers", label: "contradicted", trap: "footnote" },
    { match: "No study comparing fully remote and hybrid", label: "process", trap: "process_outside" },
    { match: "single Chinese travel agency", label: "supported", trap: "limitations_cited" },
    { match: "later retracted", label: "insufficient", trap: "limitations_cited" },
    { match: "may vary by industry and job type", label: "process", trap: "limitations_process" },
  ],
};

const oceanA = source("e02a19", "Ocean acidification and shellfish", "https://example.org/ocean/acidification-shellfish", [
  "Since the start of the industrial era, the average pH of surface ocean water has fallen by about 0.1 units, an increase in acidity of roughly 30%.",
  "Larval oysters in hatcheries on the US Pacific coast suffered mass die-offs in 2007-2008 when corrosive upwelled water entered the hatcheries.",
  "Hatcheries that began monitoring seawater chemistry and buffering their intake water recovered most of their production.",
  "Responses differ among species: some crabs and lobsters built heavier shells in more acidic water in laboratory experiments.",
]);

const hoOcean: ClaimDraftEvalCaseV1 = {
  id: "d-ho-ocean",
  split: "heldout",
  family: "footnote_draft",
  prompt: "Explain how ocean acidification affects shellfish, citing sources.",
  render: "footnotes",
  sources: [oceanA],
  draft: [
    "# Ocean acidification and shellfish",
    "",
    `Surface ocean pH has fallen by about 0.1 units since industrialisation, about 30% more acidic ${c(oceanA, 0)}.`,
    `Pacific coast oyster hatcheries saw mass larval die-offs in 2007-2008 from corrosive upwelled water ${c(oceanA, 1)}.`,
    `Hatcheries that monitored and buffered their water recovered most of their production ${c(oceanA, 2)}.`,
    `In some laboratory experiments, crabs and lobsters built heavier shells in more acidic water ${c(oceanA, 3)}.`,
    `Ocean pH has fallen by a full unit since 1900 ${c(oceanA, 0)}.`,
    `All shellfish species build thinner shells as acidity rises ${c(oceanA, 3)}.`,
    `Buffering hatchery water has saved wild oyster populations along the entire coast ${c(oceanA, 2)}.`,
    "Not verified: reports that the 2023 die-offs were caused by acidification.",
  ].join("\n"),
  labels: [
    { match: "fallen by about 0.1 units since industrialisation", label: "supported", trap: "footnote" },
    { match: "mass larval die-offs in 2007-2008", label: "supported", trap: "footnote" },
    { match: "monitored and buffered their water recovered", label: "supported", trap: "footnote" },
    { match: "crabs and lobsters built heavier shells", label: "supported", trap: "footnote" },
    { match: "fallen by a full unit since 1900", label: "contradicted", trap: "footnote" },
    { match: "All shellfish species build thinner shells", label: "contradicted", trap: "footnote" },
    { match: "saved wild oyster populations along the entire coast", label: "insufficient", trap: "footnote" },
    { match: "Not verified: reports that the 2023 die-offs", label: "process", trap: "process_outside" },
  ],
};

const vitA = source("f71c03", "Vitamin D supplementation and fractures: the VITAL trial", "https://example.org/medicine/vital-fractures", [
  "Among 25,871 generally healthy adults, vitamin D3 at 2,000 IU per day for a median of 5.3 years did not lower the risk of total fractures compared with placebo.",
  "Results were similar for nonvertebral fractures and hip fractures, and did not differ by baseline vitamin D level.",
]);
const vitB = source("f71c55", "Vitamin D and calcium in care-home residents", "https://example.org/medicine/vitd-calcium-care-homes", [
  "In older women living in care homes, combined vitamin D and calcium reduced hip fractures in an earlier trial.",
]);

const hoVitD: ClaimDraftEvalCaseV1 = {
  id: "d-ho-vitd",
  split: "heldout",
  family: "limitations",
  prompt: "Does vitamin D prevent fractures? Write a sourced note with a limitations section.",
  render: "tokens",
  sources: [vitA, vitB],
  draft: [
    "# Vitamin D and fractures",
    "",
    `In a trial of nearly 26,000 healthy adults, 2,000 IU of vitamin D3 a day did not reduce total fractures ${c(vitA, 0)}.`,
    `There was no benefit for hip fractures either, regardless of starting vitamin D level ${c(vitA, 1)}.`,
    `Vitamin D cut fracture risk by half in healthy adults ${c(vitA, 0)}.`,
    `An earlier trial found vitamin D with calcium reduced hip fractures in older women in care homes ${c(vitB, 0)}.`,
    "Could not confirm whether the care-home trial was replicated.",
    "",
    "## Limitations",
    "",
    `The large trial followed participants for a median of 5.3 years ${c(vitA, 0)}.`,
    `The trial excluded everyone over 50 ${c(vitA, 0)}.`,
    `Uncertainty about the dose is low because the trial compared five different doses ${c(vitA, 0)}.`,
    "These results may not apply to people with diagnosed deficiency, which the sources did not address separately.",
    "I relied on trial summaries rather than the full papers.",
  ].join("\n"),
  labels: [
    { match: "did not reduce total fractures", label: "supported" },
    { match: "no benefit for hip fractures either", label: "supported" },
    { match: "cut fracture risk by half", label: "contradicted" },
    { match: "reduced hip fractures in older women in care homes", label: "supported" },
    { match: "Could not confirm whether the care-home trial", label: "process", trap: "process_outside" },
    { match: "median of 5.3 years", label: "supported", trap: "limitations_cited" },
    { match: "excluded everyone over 50", label: "insufficient", trap: "limitations_cited" },
    { match: "compared five different doses", label: "contradicted", trap: "keyword_exempt" },
    { match: "may not apply to people with diagnosed deficiency", label: "process", trap: "limitations_process" },
    { match: "I relied on trial summaries", label: "process", trap: "limitations_process" },
  ],
};

const congA = source("a90b12", "The Stockholm congestion charge: evaluation", "https://example.org/transport/stockholm-charge", [
  "After the congestion charge was introduced in 2006, traffic across the charging cordon fell by about 20% and stayed close to that level in later years.",
  "Public support for the charge rose from about 30% before the trial to about 65% several years after it was made permanent.",
  "Revenue from the charge was earmarked for road investments in the Stockholm region.",
]);
const congB = source("a90b70", "Congestion pricing and air quality", "https://example.org/transport/charge-air-quality", [
  "Emissions of nitrogen oxides in the inner city fell by about 8-12% after the charge started, according to modelling.",
]);

const hoCongestion: ClaimDraftEvalCaseV1 = {
  id: "d-ho-congestion",
  split: "heldout",
  family: "multi_citation",
  prompt: "Summarize the evidence on Stockholm's congestion charge, with sources for each claim.",
  render: "tokens",
  sources: [congA, congB],
  draft: [
    "# Stockholm's congestion charge",
    "",
    `Traffic across the cordon fell about 20% and the drop persisted ${c(congA, 0)}.`,
    `The charge cut traffic and, according to modelling, inner-city nitrogen oxide emissions ${c(congA, 0)} ${c(congB, 0)}.`,
    `Public support rose from about 30% to about 65% after the charge became permanent ${c(congA, 1)}.`,
    `Support fell as residents grew used to the charge ${c(congA, 1)} ${c(congA, 0)}.`,
    `Charge revenue was set aside for regional road investment ${c(congA, 2)}.`,
    `The charge eliminated congestion and halved emissions across Sweden ${c(congA, 0)} ${c(congB, 0)} ${c(congA, 1)} ${c(congA, 2)}.`,
    "",
    "## Limitations",
    "",
    `The emissions figures come from modelling rather than direct measurement ${c(congB, 0)}.`,
    "I could not find a comparable evaluation for Gothenburg's charge.",
  ].join("\n"),
  labels: [
    { match: "fell about 20% and the drop persisted", label: "supported" },
    { match: "inner-city nitrogen oxide emissions", label: "supported", trap: "multi_citation" },
    { match: "rose from about 30% to about 65%", label: "supported" },
    { match: "Support fell as residents grew used", label: "contradicted", trap: "multi_citation" },
    { match: "set aside for regional road investment", label: "supported" },
    { match: "eliminated congestion and halved emissions", label: "insufficient", trap: "multi_citation" },
    { match: "come from modelling rather than direct", label: "supported", trap: "limitations_cited" },
    { match: "I could not find a comparable evaluation", label: "process", trap: "limitations_process" },
  ],
};

const abxReview = source("b40c08", "Antibiotics for acute sinusitis: screening and included trials", "https://example.org/reviews/antibiotics-sinusitis", [
  "Searches identified 1,036 records. After screening titles and abstracts, 64 full texts were assessed and 15 trials with 3,057 participants were included.",
  "Antibiotics shortened symptoms slightly: about 5 more people in 100 were cured at 7 to 14 days compared with placebo.",
  "Side effects, mostly gastrointestinal, were more common with antibiotics, affecting about 10 more people in 100.",
  "Full texts were excluded mainly because the trials enrolled children or did not confirm sinusitis clinically.",
]);

const hoScreening: ClaimDraftEvalCaseV1 = {
  id: "d-ho-abx",
  split: "heldout",
  family: "screening",
  prompt: "Screen the trials of antibiotics for acute sinusitis in adults and summarize what they found.",
  render: "footnotes",
  sources: [abxReview],
  draft: [
    "# Antibiotics for acute sinusitis in adults",
    "",
    "## Screening",
    "",
    `Of 1,036 records, 64 full texts were assessed and 15 trials were included ${c(abxReview, 0)}.`,
    `The included trials enrolled 3,057 participants in total ${c(abxReview, 0)}.`,
    `Most full-text exclusions were trials in children or without clinically confirmed sinusitis ${c(abxReview, 3)}.`,
    `Forty trials were included after full-text screening ${c(abxReview, 0)}.`,
    "Records were screened against the review's inclusion criteria before data extraction.",
    "",
    "## Findings",
    "",
    `About 5 more people in 100 were cured within two weeks on antibiotics than on placebo ${c(abxReview, 1)}.`,
    `Side effects were more common on antibiotics, about 10 more people in 100 ${c(abxReview, 2)}.`,
    `Antibiotics cured sinusitis in nearly every patient within three days ${c(abxReview, 1)}.`,
    `Antibiotics caused fewer side effects than placebo ${c(abxReview, 2)}.`,
  ].join("\n"),
  labels: [
    { match: "64 full texts were assessed and 15 trials", label: "supported", trap: "screening" },
    { match: "enrolled 3,057 participants", label: "supported", trap: "screening" },
    { match: "Most full-text exclusions were trials in children", label: "supported", trap: "screening" },
    { match: "Forty trials were included", label: "contradicted", trap: "screening" },
    { match: "Records were screened against the review", label: "process", trap: "process_outside" },
    { match: "About 5 more people in 100 were cured", label: "supported", trap: "footnote" },
    { match: "about 10 more people in 100", label: "supported", trap: "footnote" },
    { match: "nearly every patient within three days", label: "contradicted", trap: "footnote" },
    { match: "fewer side effects than placebo", label: "contradicted", trap: "footnote" },
  ],
};

const solarFig = source("c62d14", "Renewables 2024, Figure 2.3 (chart text)", "https://example.org/iea/renewables-2024#figure-2-3", [
  "Figure 2.3 Renewable capacity additions by technology, 2017-2023 (GW). Solar PV additions reached about 420 GW in 2023, wind about 115 GW, hydropower about 12 GW.",
  "Figure 2.4 Solar PV module prices, 2010-2023: prices fell by almost 90% over the period, with a further drop of about 50% in 2023.",
  "Figure 2.5 Share of global solar PV manufacturing capacity by country, 2023: China above 80% for wafers, cells and modules.",
]);
const solarClip = source("c62d80", "Transcript: grid integration webinar, 31:05-33:30", "https://example.org/videos/grid-webinar#t=1865", [
  "[31:05] The grid operator said curtailment of solar output in the region reached 6% of generation in 2023, up from 3% two years earlier.",
  "[32:40] She added that new battery storage, about 4 gigawatts, was expected to bring curtailment down within two years.",
]);

const hoMedia: ClaimDraftEvalCaseV1 = {
  id: "d-ho-solar",
  split: "heldout",
  family: "media",
  prompt: "Use the IEA figures and the grid webinar recording to explain how fast solar is growing.",
  render: "footnotes",
  sources: [solarFig, solarClip],
  draft: [
    "# How fast solar is growing",
    "",
    `Figure 2.3 shows solar PV additions of about 420 GW in 2023, far ahead of wind ${c(solarFig, 0)}.`,
    `Module prices fell by almost 90% between 2010 and 2023, according to Figure 2.4 ${c(solarFig, 1)}.`,
    `China held more than 80% of global capacity for wafers, cells and modules in 2023 ${c(solarFig, 2)}.`,
    `Figure 2.3 shows wind additions overtaking solar in 2023 ${c(solarFig, 0)}.`,
    `Module prices rose in 2023 after a decade of declines ${c(solarFig, 1)}.`,
    `At 31:05 in the webinar, the operator puts 2023 solar curtailment at 6% of generation ${c(solarClip, 0)}.`,
    `The operator expected about 4 gigawatts of new storage to reduce curtailment ${c(solarClip, 1)}.`,
    `The operator said curtailment had already fallen to zero by 2024 ${c(solarClip, 1)}.`,
    "The webinar was sampled at the two timestamps cited; the rest of the recording was not reviewed.",
  ].join("\n"),
  labels: [
    { match: "additions of about 420 GW in 2023", label: "supported", trap: "figure" },
    { match: "fell by almost 90% between 2010 and 2023", label: "supported", trap: "figure" },
    { match: "more than 80% of global capacity", label: "supported", trap: "figure" },
    { match: "wind additions overtaking solar", label: "contradicted", trap: "figure" },
    { match: "Module prices rose in 2023", label: "contradicted", trap: "figure" },
    { match: "2023 solar curtailment at 6%", label: "supported", trap: "transcript" },
    { match: "about 4 gigawatts of new storage", label: "supported", trap: "transcript" },
    { match: "already fallen to zero by 2024", label: "insufficient", trap: "transcript" },
    { match: "sampled at the two timestamps cited", label: "process", trap: "process_outside" },
  ],
};

const batA = source("d27e33", "Lithium-ion battery recycling", "https://example.org/materials/battery-recycling", [
  "Hydrometallurgical recycling can recover more than 95% of the cobalt, nickel and lithium in spent lithium-ion cells, according to pilot plant results.",
  "Pyrometallurgical smelting recovers cobalt and nickel well but loses most of the lithium to slag unless further processing is added.",
  "The European Union's battery regulation requires recycling plants to recover 80% of lithium from waste batteries by the end of 2031.",
  "Collection is a bottleneck: only a minority of portable lithium-ion batteries sold in Europe are currently collected at end of life.",
]);

const hoBattery: ClaimDraftEvalCaseV1 = {
  id: "d-ho-battery",
  split: "heldout",
  family: "limitations",
  prompt: "How well can lithium-ion batteries be recycled? Write a sourced note with limitations.",
  render: "footnotes",
  sources: [batA],
  draft: [
    "# Recycling lithium-ion batteries",
    "",
    `Pilot hydrometallurgical plants recover over 95% of the cobalt, nickel and lithium in spent cells ${c(batA, 0)}.`,
    `Smelting recovers cobalt and nickel but loses most lithium to slag without extra processing ${c(batA, 1)}.`,
    `EU rules require 80% of lithium to be recovered from waste batteries by the end of 2031 ${c(batA, 2)}.`,
    `Smelting recovers lithium more completely than hydrometallurgy ${c(batA, 1)}.`,
    `The EU already requires full lithium recovery from 2025 ${c(batA, 2)}.`,
    "",
    "## Limitations",
    "",
    `Only a minority of portable lithium-ion batteries in Europe are collected at end of life ${c(batA, 3)}.`,
    `Collection rates exceed 90% in every EU country ${c(batA, 3)}.`,
    `Confidence in the recovery rates is limited because they come from pilot plants ${c(batA, 0)}.`,
    "I could not find cost figures for either process in the sources gathered.",
    "This note does not cover recycling outside Europe.",
  ].join("\n"),
  labels: [
    { match: "recover over 95% of the cobalt", label: "supported", trap: "footnote" },
    { match: "loses most lithium to slag", label: "supported", trap: "footnote" },
    { match: "80% of lithium to be recovered", label: "supported", trap: "footnote" },
    { match: "recovers lithium more completely than hydrometallurgy", label: "contradicted", trap: "footnote" },
    { match: "already requires full lithium recovery from 2025", label: "contradicted", trap: "footnote" },
    { match: "Only a minority of portable lithium-ion batteries", label: "supported", trap: "limitations_cited" },
    { match: "exceed 90% in every EU country", label: "contradicted", trap: "limitations_cited" },
    { match: "come from pilot plants", label: "supported", trap: "keyword_exempt" },
    { match: "I could not find cost figures", label: "process", trap: "limitations_process" },
    { match: "does not cover recycling outside Europe", label: "process", trap: "limitations_process" },
  ],
};

const screenA = source("e48f21", "Adolescent screen time and wellbeing", "https://example.org/psych/screen-time-wellbeing", [
  "Across three large datasets covering more than 350,000 adolescents, digital technology use explained at most 0.4% of the variation in wellbeing.",
  "The association between technology use and wellbeing was about as large as the association between wellbeing and regularly eating potatoes.",
  "The authors cautioned that the datasets were cross-sectional and could not show whether technology use caused lower wellbeing.",
]);
const screenB = source("e48f90", "Social media and depressive symptoms in girls", "https://example.org/psych/social-media-girls", [
  "In a UK cohort, girls who used social media for more than five hours a day were more likely to report depressive symptoms than girls who used it for one to three hours.",
]);

const hoScreen: ClaimDraftEvalCaseV1 = {
  id: "d-ho-screen",
  split: "heldout",
  family: "footnote_draft",
  prompt: "What does the research say about screen time and teenage wellbeing? Sourced note please.",
  render: "footnotes",
  sources: [screenA, screenB],
  draft: [
    "# Screen time and teenage wellbeing",
    "",
    `In data on over 350,000 adolescents, technology use explained at most 0.4% of the variation in wellbeing ${c(screenA, 0)}.`,
    `The association was about as large as that between wellbeing and eating potatoes ${c(screenA, 1)}.`,
    `Heavy social media use, over five hours a day, was linked to more depressive symptoms in girls ${c(screenB, 0)}.`,
    `Screen time explains about a third of the variation in teenage wellbeing ${c(screenA, 0)}.`,
    `The large datasets proved that screens cause depression ${c(screenA, 2)}.`,
    "Could not verify: claims from news articles that screen time has doubled since 2019.",
    "",
    "## Limitations",
    "",
    `The datasets were cross-sectional, so they cannot show cause and effect ${c(screenA, 2)}.`,
    `The cohort study followed boys only ${c(screenB, 0)}.`,
    "Evidence is mixed, and the sources disagree on how large any effect is.",
  ].join("\n"),
  labels: [
    { match: "explained at most 0.4% of the variation", label: "supported", trap: "footnote" },
    { match: "eating potatoes", label: "supported", trap: "footnote" },
    { match: "over five hours a day, was linked", label: "supported", trap: "footnote" },
    { match: "about a third of the variation", label: "contradicted", trap: "footnote" },
    { match: "proved that screens cause depression", label: "contradicted", trap: "footnote" },
    { match: "Could not verify: claims from news articles", label: "process", trap: "process_outside" },
    { match: "cross-sectional, so they cannot show", label: "supported", trap: "limitations_cited" },
    { match: "followed boys only", label: "contradicted", trap: "limitations_cited" },
    { match: "Evidence is mixed, and the sources disagree", label: "process", trap: "limitations_process" },
  ],
};

const wageA = source("f15a07", "Minimum wages and employment: a review", "https://example.org/econ/minimum-wage-review", [
  "Studies of moderate minimum wage increases in the United States since the 1990s mostly find small or no reductions in employment among low-wage workers.",
  "A study of Seattle's increase to 13 dollars an hour found reduced hours for low-wage workers, while an earlier increase to 11 dollars had little effect.",
  "Earnings of affected low-wage workers generally rose after moderate increases.",
]);

const hoWage: ClaimDraftEvalCaseV1 = {
  id: "d-ho-wage",
  split: "heldout",
  family: "limitations",
  prompt: "Do minimum wage increases cost jobs? Write a careful sourced note.",
  render: "tokens",
  sources: [wageA],
  draft: [
    "# Minimum wages and jobs",
    "",
    `Moderate US minimum wage increases since the 1990s mostly show small or no job losses for low-wage workers ${c(wageA, 0)}.`,
    `Earnings of affected low-wage workers generally went up ${c(wageA, 2)}.`,
    `Seattle's rise to 13 dollars an hour was linked to fewer hours for low-wage workers ${c(wageA, 1)}.`,
    `Every minimum wage increase studied caused large job losses ${c(wageA, 0)}.`,
    "Not independently verified: the claim that Seattle restaurants closed in large numbers.",
    "",
    "## Limitations",
    "",
    `Seattle's earlier rise to 11 dollars had little measured effect ${c(wageA, 1)}.`,
    `The review covered only European countries ${c(wageA, 0)}.`,
    "Effects of very large increases remain uncertain because few have been studied.",
  ].join("\n"),
  labels: [
    { match: "mostly show small or no job losses", label: "supported" },
    { match: "Earnings of affected low-wage workers generally went up", label: "supported" },
    { match: "linked to fewer hours for low-wage workers", label: "supported" },
    { match: "caused large job losses", label: "contradicted" },
    { match: "Not independently verified: the claim that Seattle", label: "process", trap: "process_outside" },
    { match: "earlier rise to 11 dollars had little", label: "supported", trap: "limitations_cited" },
    { match: "covered only European countries", label: "contradicted", trap: "limitations_cited" },
    { match: "Effects of very large increases remain uncertain", label: "process", trap: "limitations_process" },
  ],
};

export const CLAIM_DRAFT_EVAL_SET_V1: readonly ClaimDraftEvalCaseV1[] = [
  calFootnote,
  calMulti,
  calLimits,
  calScreening,
  calMedia,
  calTrees,
  hoMicro,
  hoFasting,
  hoRemote,
  hoOcean,
  hoVitD,
  hoCongestion,
  hoScreening,
  hoMedia,
  hoBattery,
  hoScreen,
  hoWage,
];
