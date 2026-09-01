/**
 * Grounding validation — the check the "Grounded in MES data" badge stands on.
 *
 * Rule 2: **evidence is cited by record ID, never by prose.** This file is what
 * makes that rule enforceable rather than aspirational. Every
 * `{record_id, field, value}` triple the model returned is resolved by exact
 * lookup against the records it was actually shown — the same `citableRecords`
 * object that built the prompt, so the validator can never judge a citation
 * invalid because it was looking at a different copy of the order.
 *
 * ── Three checks, deliberately ──────────────────────────────────────────────
 * 1. The record exists in the citable set.
 * 2. That record has the field named.
 * 3. The field holds the value claimed.
 *
 * Check 3 is the one that earns the badge. A model can name a real record and a
 * real field and still put the wrong number beside it, and that is precisely the
 * failure a supervisor cannot catch by eye — "EVT-2231 durationMinutes 24" looks
 * exactly as authoritative as "EVT-2231 durationMinutes 42".
 *
 * A fourth check covers the analysis as a whole: **every issue type explained
 * must be one the rules actually detected.** An invented issue cites nothing and
 * would otherwise pass all three citation checks by having no citations to fail.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * Not a fact-checker for the prose. The `summary` and `explanation` fields are
 * natural language and are not validated — nothing here can tell you whether
 * "the tooling is worn" is true. What it tells you is that every *number and
 * record* the model put on screen came from the MES, which is the claim the
 * badge makes and the only one it should.
 */

import type { IssueType } from "@/lib/mes/rules-config";
import type { OrderDetail } from "@/lib/mes/types";
import { citableRecords } from "./context";
import type { Analysis, EvidenceRefOut } from "./schema";

export type CitationFault = "unknown_record" | "unknown_field" | "value_mismatch";

export interface CitationProblem {
  fault: CitationFault;
  /** Where in the output it sits — `issues[0].evidence[2]`. Renderable, and greppable in a log. */
  path: string;
  recordId: string;
  field: string;
  /** What the model said the field holds. */
  claimed: string;
  /** What it actually holds. Absent when the record or field does not exist. */
  actual?: string;
}

export interface GroundingReport {
  /** The badge condition. True only when nothing below found anything. */
  grounded: boolean;
  /** How many citations were checked. A grounded analysis with zero citations is not a thing — the schema requires at least one per issue. */
  citationsChecked: number;
  problems: CitationProblem[];
  /**
   * Issue types the model explained that no rule fired. A grounding failure:
   * the rules decide what is wrong, and an issue they did not detect is the
   * model inventing a problem.
   */
  unfiredIssueTypes: string[];
  /**
   * Issue types the rules fired that the model did not explain. **Not** a
   * grounding failure — everything on screen is still true, there is just less
   * of it. Surfaced so an incomplete answer is visible rather than silent.
   */
  unexplainedIssueTypes: string[];
}

/**
 * Validate an analysis against the order it claims to describe.
 *
 * `firedIssueTypes` is passed in rather than re-derived by calling `detectIssues`
 * here: the types that must be checked against are the ones that were *sent to
 * the model*, and re-running the rules would compare against a fresh detection
 * that the model never saw.
 */
export function validateGrounding(
  order: OrderDetail,
  analysis: Analysis,
  firedIssueTypes: IssueType[],
): GroundingReport {
  const records = citableRecords(order);
  const problems: CitationProblem[] = [];
  let citationsChecked = 0;

  const check = (ref: EvidenceRefOut, path: string) => {
    citationsChecked += 1;
    const problem = checkCitation(records, ref, path);
    if (problem) problems.push(problem);
  };

  analysis.issues.forEach((issue, i) => {
    issue.evidence.forEach((ref, j) => check(ref, `issues[${i}].evidence[${j}]`));
  });
  analysis.recommendation.evidence.forEach((ref, i) =>
    check(ref, `recommendation.evidence[${i}]`),
  );

  const fired = new Set<string>(firedIssueTypes);
  const explained = new Set<string>(analysis.issues.map((issue) => issue.type));

  const unfiredIssueTypes = [...explained].filter((type) => !fired.has(type));
  const unexplainedIssueTypes = [...fired].filter((type) => !explained.has(type));

  return {
    grounded: problems.length === 0 && unfiredIssueTypes.length === 0,
    citationsChecked,
    problems,
    unfiredIssueTypes,
    unexplainedIssueTypes,
  };
}

function checkCitation(
  records: Record<string, Record<string, string>>,
  ref: EvidenceRefOut,
  path: string,
): CitationProblem | null {
  // Record IDs are matched case-insensitively. `PO-10382` and `po-10382` are the
  // same record everywhere else in this app — the order route accepts either —
  // and failing a citation on capitalisation would be a validator bug wearing a
  // grounding failure's clothes. Field names and values are matched exactly:
  // those are data, and "42" is not "42 minutes".
  const recordId = ref.record_id.trim();
  const record = records[recordId] ?? records[recordId.toUpperCase()];

  if (!record) {
    return { fault: "unknown_record", path, recordId, field: ref.field, claimed: ref.value };
  }

  const field = ref.field.trim();
  if (!(field in record)) {
    return { fault: "unknown_field", path, recordId, field, claimed: ref.value };
  }

  const actual = record[field];
  // Trimmed, because trailing whitespace in a copied value is a transcription
  // artefact and not a claim about the MES. Nothing else is normalised.
  if (actual.trim() !== ref.value.trim()) {
    return { fault: "value_mismatch", path, recordId, field, claimed: ref.value, actual };
  }

  return null;
}

/**
 * The corrective turn sent when a first attempt fails grounding.
 *
 * Names each bad citation by path and says what the record actually holds, so
 * the retry is a correction rather than a re-roll. A retry that just says "try
 * again" gets a differently-wrong answer about as often as a right one.
 */
export function groundingFeedback(report: GroundingReport): string {
  const lines: string[] = [
    "Your previous answer did not pass grounding validation and was rejected. Fix these problems and call the tool again.",
  ];

  for (const problem of report.problems) {
    if (problem.fault === "unknown_record") {
      lines.push(
        `- ${problem.path}: there is no record "${problem.recordId}" in citable_records. Cite only the record IDs you were given.`,
      );
    } else if (problem.fault === "unknown_field") {
      lines.push(
        `- ${problem.path}: record ${problem.recordId} has no field "${problem.field}".`,
      );
    } else {
      lines.push(
        `- ${problem.path}: ${problem.recordId}.${problem.field} is "${problem.actual}", not "${problem.claimed}". Copy values exactly.`,
      );
    }
  }

  for (const type of report.unfiredIssueTypes) {
    lines.push(
      `- You explained a ${type} issue. No rule detected one on this order. Explain only the detected issues you were given.`,
    );
  }

  return lines.join("\n");
}
