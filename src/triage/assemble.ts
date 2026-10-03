// ASSEMBLE — build the final schema-valid ItemOutput from the four pipeline artifacts.
//
// No async. Reads captured tool evidence once through getToolCallsForItem(item.id),
// whose result is passed through UNCHANGED (no edits to call_id/name/args/result_summary,
// no add/drop/reorder). See src/validate.ts for bidirectional trace validation.

import { getToolCallsForItem } from "../tools.js";
import type {
  Discipline,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
} from "../types.js";
import type {
  OrchestrationResult,
  ScoreResult,
  SignalBundle,
} from "./types.js";

const VALID_DISCIPLINES: ReadonlySet<Discipline> = new Set<Discipline>([
  "SLP",
  "OT",
  "PT",
]);

/**
 * Build the schema-valid ItemOutput. Reconstructs every field explicitly so the
 * object never carries extra keys (schema is additionalProperties:false) or
 * undefined values, and so discipline can never surface as an empty array.
 */
export function assembleItemOutput(
  item: InboxItem,
  bundle: SignalBundle,
  score: ScoreResult,
  orchestration: OrchestrationResult,
): ItemOutput {
  return {
    item_id: item.id,
    classification: score.classification,
    urgency: score.urgency,
    // Public output contract requires manual review for every item.
    requires_human_review: true,
    extracted_intake: normalizeIntake(bundle.llm.extracted_intake),
    missing_info: toStringArray(orchestration.missing_info),
    // PASS THROUGH UNCHANGED. getToolCallsForItem already clones args and filters
    // by item ID; we surface every entry exactly once with no edits.
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: ensureNonEmpty(
      orchestration.recommended_next_action,
      "Hold for human review.",
    ),
    draft_reply:
      typeof orchestration.draft_reply === "string"
        ? orchestration.draft_reply
        : null,
    task_ids: toStringArray(orchestration.task_ids),
    // escalation passes through from score: null OR { reason:non-empty, severity:"P0"|"P1" }.
    escalation: normalizeEscalation(score.escalation),
    decision_rationale: composeRationale(item, bundle, score, orchestration),
  };
}

/**
 * Rebuild ExtractedIntake with exactly the 7 schema keys. discipline must be a
 * non-empty Discipline[] OR null — coerce [] (or any all-invalid array) to null.
 */
function normalizeIntake(intake: ExtractedIntake): ExtractedIntake {
  const source = intake ?? ({} as Partial<ExtractedIntake>);

  return {
    child_name: nullableString(source.child_name),
    dob_or_age: nullableString(source.dob_or_age),
    parent_contact: nullableString(source.parent_contact),
    discipline: normalizeDiscipline(source.discipline),
    diagnosis_or_concern: nullableString(source.diagnosis_or_concern),
    payer: nullableString(source.payer),
    member_id: nullableString(source.member_id),
  };
}

/**
 * discipline: non-empty array of valid Discipline values, or null. Empty array,
 * non-array, or array with no valid members all coerce to null (schema minItems:1).
 */
function normalizeDiscipline(value: unknown): Discipline[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const seen = new Set<Discipline>();
  for (const entry of value) {
    if (typeof entry === "string" && VALID_DISCIPLINES.has(entry as Discipline)) {
      seen.add(entry as Discipline);
    }
  }

  return seen.size > 0 ? [...seen] : null;
}

/** Coerce to a string or null; never undefined (schema is additionalProperties:false). */
function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Defensive: only emit a real string[] (no undefined holes, no non-array). */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** escalation: null OR { reason:non-empty string, severity:"P0"|"P1" }. */
function normalizeEscalation(
  escalation: ScoreResult["escalation"],
): ItemOutput["escalation"] {
  if (!escalation) {
    return null;
  }

  const reason = ensureNonEmpty(escalation.reason, "Escalated for human review.");
  const severity = escalation.severity === "P0" ? "P0" : "P1";
  return { reason, severity };
}

/** Guarantee minLength:1 for required non-empty string fields. */
function ensureNonEmpty(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return fallback;
}

/**
 * Compose a single auditable, human-readable decision_rationale from:
 *   - score.rationale_signals (fired gate/score/signals + source)
 *   - orchestration.notes (tool outcomes, e.g. "insurance: out_of_network")
 *   - a one-clause classification justification (gate + perception source)
 * Always returns a non-empty string (schema minLength:1).
 */
function composeRationale(
  item: InboxItem,
  bundle: SignalBundle,
  score: ScoreResult,
  orchestration: OrchestrationResult,
): string {
  const segments: string[] = [];

  const signals = toStringArray(score.rationale_signals);
  if (signals.length > 0) {
    segments.push(`Signals: ${signals.join("; ")}.`);
  }

  const notes = toStringArray(orchestration.notes);
  if (notes.length > 0) {
    segments.push(`Notes: ${notes.join("; ")}.`);
  }

  // One-clause classification justification, tying the final label to the gate and
  // which perception path (llm vs fallback) produced the signals.
  segments.push(
    `Classified as ${score.classification} at ${score.urgency} via ${score.gate} gate ` +
      `(perception: ${bundle.source}/${bundle.model_path}).`,
  );

  const rationale = segments.join(" ").trim();
  return rationale.length > 0
    ? rationale
    : `Item ${item.id} held for human review.`;
}
