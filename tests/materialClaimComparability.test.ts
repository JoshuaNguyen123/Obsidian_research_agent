import test from "node:test";
import assert from "node:assert/strict";
import {detectEvidenceConflicts,projectEvidenceConflictAcknowledgements,evaluateEvidenceConflictAcceptance} from "../src/agent/evidenceConflicts";
const pairs=[
  {
    "id": "conflict:69a083dd",
    "passages": [
      {
        "id": "source:1mv939a:passage:588-1288",
        "text": "imed to (1) evaluate whether the rhythmic sensory stimulation (RSS) treatments with different parameters would yield different effects on participants; and (2) evaluate the efficacy of RSS in reducing the severity of fibromyalgia symptoms. The reported experiments involved two RSS treatment groups, as described in the Methods, both of which received RSS treatment albeit with different specifications. The study did not include a true sham control treatment. The results of pre- versus post-treatment analyses reported in the article suggested that RSS stimulation may impact fibromyalgia symptoms. However, given the lack of a sham control group, one cannot distinguish effects of either treatment",
        "evidenceId": "vault:onp5j7"
      },
      {
        "id": "source:z8alm8:passage:28043-28743",
        "text": "p < 0.005\r\n\r\n## body paragraph 27\r\n\r\nRegarding patient’s impression of change as measured with the PGI-I, of the 38 patients who completed the final study visit 50% reported feeling no change in fibromyalgia symptoms, while 44% of participants reported feeling better with the intervention, and 6% indicated that symptoms were worse after completing the study. The average benefit score reported by participants on the GBI was +9 (range: -16 to +72), which suggests that participants perceived an overall improvement of approximately 10% in quality of life after the intervention.\r\n\r\n## body paragraph 28\r\n\r\nWe were also interested in whether the statistically significant changes in fibromyalgia sym",
        "evidenceId": "vault:rcsbgv"
      }
    ]
  },
  {
    "id": "conflict:47a9baf0",
    "passages": [
      {
        "id": "source:1wu7ucx:passage:865-1565",
        "text": "tio Pg. 6-9 3b Important changes to methods after trial commencement (such as eligibility criteria), with reasons n/a Participants 4a Eligibility criteria for participants Pg. 5-6 4b Settings and locations where the data were collected Pg. 6-7 Interventions 5 The interventions for each group with sufficient details to allow replication, including how and when they were actually administered Pg. 6-7 Outcomes 6a Completely defined pre-specified primary and secondary outcome measures, including how and when they were assessed Pg. 7-9 6b Any changes to trial outcomes after the trial commenced, with reasons Pg. 6, lines 144-146 Sample size 7a How sample size was determined Pg. 10 7b When applicab",
        "evidenceId": "vault:svizsq"
      },
      {
        "id": "source:z8alm8:passage:28043-28743",
        "text": "p < 0.005\r\n\r\n## body paragraph 27\r\n\r\nRegarding patient’s impression of change as measured with the PGI-I, of the 38 patients who completed the final study visit 50% reported feeling no change in fibromyalgia symptoms, while 44% of participants reported feeling better with the intervention, and 6% indicated that symptoms were worse after completing the study. The average benefit score reported by participants on the GBI was +9 (range: -16 to +72), which suggests that participants perceived an overall improvement of approximately 10% in quality of life after the intervention.\r\n\r\n## body paragraph 28\r\n\r\nWe were also interested in whether the statistically significant changes in fibromyalgia sym",
        "evidenceId": "vault:rcsbgv"
      }
    ]
  },
  {
    "id": "conflict:bbebb7ef",
    "passages": [
      {
        "id": "source:g84p37:passage:22643-23343",
        "text": "as well as practicing with a \r\nprepared practice CD that included physical and singing exercises, meditation dialogue, \r\nand accompaniments. QEEG results are based on a random sample (9 from group of 21) \r\nthat was tested before and after  the intervention. D ata comparison between scores \r\nbefore and after intervention showed significant improvement. The resting QEEG data \r\nrevealed greater left right hemispheric activity symmetry,  reduced hyperactivity in the \r\nright prefrontal area, and reduced hypercoherence.     \r\nRecent research has recognized  the potential of low frequency s timulation on \r\nbrain response. Koike et al.  (2012) studied 15 elderly subjects who had symptoms of \r\ndepres",
        "evidenceId": "vault:d8f09e"
      },
      {
        "id": "source:z8alm8:passage:28043-28743",
        "text": "p < 0.005\r\n\r\n## body paragraph 27\r\n\r\nRegarding patient’s impression of change as measured with the PGI-I, of the 38 patients who completed the final study visit 50% reported feeling no change in fibromyalgia symptoms, while 44% of participants reported feeling better with the intervention, and 6% indicated that symptoms were worse after completing the study. The average benefit score reported by participants on the GBI was +9 (range: -16 to +72), which suggests that participants perceived an overall improvement of approximately 10% in quality of life after the intervention.\r\n\r\n## body paragraph 28\r\n\r\nWe were also interested in whether the statistically significant changes in fibromyalgia sym",
        "evidenceId": "vault:rcsbgv"
      }
    ]
  },
  {
    "id": "conflict:7417525c",
    "passages": [
      {
        "id": "source:1mv939a:passage:588-1288",
        "text": "imed to (1) evaluate whether the rhythmic sensory stimulation (RSS) treatments with different parameters would yield different effects on participants; and (2) evaluate the efficacy of RSS in reducing the severity of fibromyalgia symptoms. The reported experiments involved two RSS treatment groups, as described in the Methods, both of which received RSS treatment albeit with different specifications. The study did not include a true sham control treatment. The results of pre- versus post-treatment analyses reported in the article suggested that RSS stimulation may impact fibromyalgia symptoms. However, given the lack of a sham control group, one cannot distinguish effects of either treatment",
        "evidenceId": "vault:onp5j7"
      },
      {
        "id": "source:1wu7ucx:passage:865-1565",
        "text": "tio Pg. 6-9 3b Important changes to methods after trial commencement (such as eligibility criteria), with reasons n/a Participants 4a Eligibility criteria for participants Pg. 5-6 4b Settings and locations where the data were collected Pg. 6-7 Interventions 5 The interventions for each group with sufficient details to allow replication, including how and when they were actually administered Pg. 6-7 Outcomes 6a Completely defined pre-specified primary and secondary outcome measures, including how and when they were assessed Pg. 7-9 6b Any changes to trial outcomes after the trial commenced, with reasons Pg. 6, lines 144-146 Sample size 7a How sample size was determined Pg. 10 7b When applicab",
        "evidenceId": "vault:svizsq"
      }
    ]
  },
  {
    "id": "conflict:9e2db364",
    "passages": [
      {
        "id": "source:1mv939a:passage:588-1288",
        "text": "imed to (1) evaluate whether the rhythmic sensory stimulation (RSS) treatments with different parameters would yield different effects on participants; and (2) evaluate the efficacy of RSS in reducing the severity of fibromyalgia symptoms. The reported experiments involved two RSS treatment groups, as described in the Methods, both of which received RSS treatment albeit with different specifications. The study did not include a true sham control treatment. The results of pre- versus post-treatment analyses reported in the article suggested that RSS stimulation may impact fibromyalgia symptoms. However, given the lack of a sham control group, one cannot distinguish effects of either treatment",
        "evidenceId": "vault:onp5j7"
      },
      {
        "id": "source:1wu7ucx:passage:1942-2642",
        "text": "lly numbered containers), describing any steps taken to conceal the sequence until interventions were assigned Pg. 9 \r\n Implementation 10 Who generated the random allocation sequence, who enrolled participants, and who assigned participants to interventions Pg. 9 \r\n\r\n\r\n## Original physical page 2\r\n\r\nCONSORT 2010 checklist  Page 2 \r\nBlinding 11a If done, who was blinded after assignment to interventions (for example, participants, care providers, those assessing outcomes) and how Pg. 9 11b If relevant, description of the similarity of interventions Pg. 6 Statistical methods 12a Statistical methods used to compare groups for primary and secondary outcomes Pg. 9-10 12b Methods for additional an",
        "evidenceId": "vault:svizsq"
      }
    ]
  }
];
for(const pair of pairs)test("actual distinct-claim pair "+pair.id,()=>assert.deepEqual(detectEvidenceConflicts(pair.passages),[]));
test("negation in a separate sentence does not negate the measured assertion",()=>{
 const rows=detectEvidenceConflicts([{id:"source:a:passage:0-200",text:"Calibration was not available. Catalyst conversion efficiency reached 92 percent under load."},{id:"source:b:passage:0-200",text:"Catalyst conversion efficiency reached 92 percent under load."}]);assert.deepEqual(rows,[]);
});
test("true polarity inside a longer source remains material",()=>{
 const ids=["source:a:passage:0-200","source:b:passage:0-200"];
 const rows=detectEvidenceConflicts([{id:ids[0],text:"Reporting details are limited. Independent trials show the quantum battery electrolyte remains stable under load."},{id:ids[1],text:"Methods are described separately. Independent trials show the quantum battery electrolyte does not remain stable under load."}]);assert.equal(rows.length,1);
 const output="The result is stable ["+ids.join("] [")+"].";
 const projected=projectEvidenceConflictAcknowledgements(rows,output);
 assert.ok(evaluateEvidenceConflictAcceptance({conflicts:projected,finalOutput:output}).missing.some(m=>m.startsWith("open_evidence_conflicts:")));
});
test("true numeric disagreement inside a longer source remains material",()=>{
 const rows=detectEvidenceConflicts([{id:"source:a:passage:0-200",text:"Reporting details are limited. Catalyst conversion efficiency reached 92 percent under load."},{id:"source:b:passage:0-200",text:"Methods are described separately. Catalyst conversion efficiency reached 41 percent under load."}]);assert.equal(rows.length,1);
});
test("same source versioned passages are contextual rather than independent",()=>{
 const rows=detectEvidenceConflicts([{id:"source:a:version:abcd:passage:0-100",text:"Catalyst conversion efficiency reached 92 percent under load."},{id:"source:a:version:abcd:passage:100-200",text:"Catalyst conversion efficiency reached 41 percent under load."}]);assert.deepEqual(rows,[]);
});
test("distinct versioned source numeric contradiction is retained",()=>{
 const rows=detectEvidenceConflicts([{id:"source:a:version:abcd:passage:0-100",text:"Catalyst conversion efficiency reached 92 percent under load."},{id:"source:b:version:abcd:passage:0-100",text:"Catalyst conversion efficiency reached 41 percent under load."}]);assert.equal(rows.length,1);
});
test("Pg page metadata cannot become a patient estimate",()=>{
 const rows=detectEvidenceConflicts([{id:"source:a:passage:0-100",text:"Participant sample population count is documented Pg. 9."},{id:"source:b:passage:0-100",text:"Participant sample population count is documented Pg. 38."}]);assert.deepEqual(rows,[]);
});

test("different immutable versions at one locator preserve a real changed estimate",()=>{
  const rows=detectEvidenceConflicts([{id:"source:a:version:abcd:passage:0-100",text:"Catalyst conversion efficiency reached 92 percent under load."},{id:"source:a:version:efgh:passage:0-100",text:"Catalyst conversion efficiency reached 41 percent under load."}]);
  assert.equal(rows.length,1);
});
