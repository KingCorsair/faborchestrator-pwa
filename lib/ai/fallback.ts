/**
 * Cached known-good analyses.
 *
 * CLAUDE.md asks for one for `PO-10382` so the demo survives an API timeout.
 * The demo is the point: a supervisor scenario rehearsed in front of a customer
 * cannot hinge on a network call, and "it usually works" is not a thing anyone
 * wants to say in that room.
 *
 * Two rules keep this honest:
 *
 *  1. **A cached analysis is never presented as a live one.** `analyzeOrder`
 *     tags every result with its `source`, the API returns it, and the screen
 *     says so on the card. A fallback the audience cannot see is a lie the
 *     demo tells for you.
 *  2. **Every citation here resolves against the real fixture.** These are the
 *     same `{record_id, field, value}` triples the live path emits, checked by
 *     the same test — a fallback that would fail Tier 2's grounding validation
 *     would be worse than no fallback, because it would teach the audience to
 *     trust a badge that means nothing.
 *
 * This is written by hand, not captured from a model run, so it stays stable
 * when the prompt changes.
 */

import type { Analysis } from "./schema";

const CACHED: Record<string, Analysis> = {
  // Rewritten to the length budget on 2026-08-13, from fourteen sentences to
  // six. It is also the worked example of the format: one thread in the
  // summary, one sentence per issue adding only what that issue contributes,
  // and no figure in prose that the citation beside it already carries.
  "PO-10382": {
    summary:
      "One feeder fault with three symptoms: the station 3 magazine on ASM-04 is misfeeding, which accounts for the scrap, the stoppage and the shortfall alike.",
    issues: [
      {
        type: "QUALITY_PROBLEM",
        explanation:
          "Scrap is concentrated in placement defects — voiding under connector J2 and off-centre housings — both typical of parts arriving skewed from a misfeeding magazine.",
        evidence: [
          { record_id: "PO-10382", field: "scrapQty", value: "56" },
          { record_id: "PO-10382", field: "completedQty", value: "620" },
          { record_id: "DEF-0417", field: "description", value: "Voiding under connector J2" },
          { record_id: "DEF-0418", field: "description", value: "Housing seated off-centre" },
        ],
      },
      {
        type: "MACHINE_DOWNTIME",
        explanation:
          "The magazine eventually jammed hard enough to stop the line, and a magazine that jams has usually been misfeeding for a while beforehand.",
        evidence: [
          { record_id: "EVT-2231", field: "durationMinutes", value: "42" },
          {
            record_id: "EVT-2231",
            field: "reason",
            value: "Feeder jam at station 3 — magazine misfeed",
          },
          { record_id: "EVT-2231", field: "reasonCode", value: "FEEDER-JAM" },
        ],
      },
      {
        type: "PRODUCTION_DELAY",
        explanation:
          "The shortfall against the planned rate is about what the stoppage and the scrapped units cost between them, so the line is not running slow.",
        evidence: [
          { record_id: "PO-10382", field: "completedQty", value: "620" },
          { record_id: "PO-10382", field: "plannedRatePerHour", value: "125" },
          { record_id: "OPR-10382-30", field: "startedAt", value: "2026-08-10T08:00:00.000Z" },
        ],
      },
    ],
    recommendation: {
      action:
        "Stop ASM-04 and have maintenance inspect and reseat the station 3 feeder magazine before running more of this order.",
      rationale:
        "The feeder is still in the line, so every unit run before it is fixed risks joining the scrap already booked against this order.",
      evidence: [
        {
          record_id: "EVT-2231",
          field: "reason",
          value: "Feeder jam at station 3 — magazine misfeed",
        },
        { record_id: "DEF-0417", field: "defectCode", value: "SOLDER-VOID" },
        { record_id: "DEF-0418", field: "defectCode", value: "ALIGN-OFFSET" },
        { record_id: "PO-10382", field: "scrapQty", value: "56" },
      ],
    },
  },
};

/** The cached analysis for an order, or null when there is none. */
export function cachedAnalysisFor(orderNumber: string): Analysis | null {
  return CACHED[orderNumber.toUpperCase()] ?? null;
}

/** Order numbers that have a cached analysis. Used by the tests. */
export function cachedOrderNumbers(): string[] {
  return Object.keys(CACHED);
}
