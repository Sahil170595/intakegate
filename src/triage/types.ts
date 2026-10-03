// Internal contracts between perception, scoring, local orchestration and assembly.
//
// Pipeline (in src/agent.ts):
//   bundle        = await perceive(item)                              // perceive.ts
//   score         = scoreUrgency(bundle)                              // score.ts   (pure)
//   orchestration = await withItemContext(item.id,                    // orchestrate.ts
//                     () => orchestrate(item, bundle, score))
//   output        = assembleItemOutput(item, bundle, score, orchestration) // assemble.ts

import type {
  Classification,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
  Urgency,
} from "../types.js";

export type SafetySeverity = "none" | "possible" | "clear";
export type TimeSensitivity = "none" | "same_day" | "urgent";

/**
 * Lexical signals over `subject + body`; context, negation and paraphrases may be missed.
 */
export interface RegexSignals {
  /** Lexical safety backstop; not a validated semantic detector. */
  safeguarding_hit: boolean;
  /** Temporal-urgency lexicon: "today", "this morning", "same-day", "3pm today". */
  same_day_hit: boolean;
  /** Shout markers: "URGENT", "ASAP", "!!!". NOT a P-driver on its own (weight 0 in scorer). */
  urgent_words: boolean;
  /** Marketing/spam lexicon. */
  spam_hit: boolean;
  has_member_id: boolean;
  has_dob: boolean;
  has_payer: boolean;
  /** Acknowledgement/FYI markers with no request verb. */
  fyi_only: boolean;
}

/**
 * Advisory signals produced by the LLM cascade OR the keyless fallback.
 * Whatever fills these, the scorer treats them identically.
 */
export interface PerceptionSignals {
  /** The 7 ExtractedIntake fields (nulls allowed; discipline is a non-empty array or null). */
  extracted_intake: ExtractedIntake;
  /** Proposed Classification — advisory; the scorer/code makes the final call. */
  classification: Classification;
  safety_severity: SafetySeverity;
  /** One short sentence; folded into decision_rationale. */
  safety_reason: string;
  /** Is the safety concern caregiving/abuse/neglect (vs. a vague medical worry)? Gates P0. */
  safety_is_caregiving: boolean;
  time_sensitivity: TimeSensitivity;
  requires_action: boolean;
}

/** Everything the scorer consumes. `source`/`model_path` record which path filled `llm`. */
export interface SignalBundle {
  item_id: string;
  regex: RegexSignals;
  llm: PerceptionSignals;
  /** "llm" when the cascade ran; "fallback" when the keyless heuristic path ran. */
  source: "llm" | "fallback";
  /** For audit/rationale, e.g. "haiku", "haiku->sonnet", "fallback". */
  model_path: string;
}

/**
 * PERCEIVE (perceive.ts): targeted cascade + regex + keyless fallback -> SignalBundle.
 * MUST NOT call routing tools. Optional model execution is explicit opt-in and outside item context.
 */
export type Perceive = (item: InboxItem) => Promise<SignalBundle>;

export type Gate = "P0_safeguarding" | "P1_noncaregiving_safety" | "operational";

/**
 * SCORE (score.ts): PURE, deterministic. Implements the scorer precedence:
 *   Step 1  P0 hard gate (categorical): regex.safeguarding_hit
 *           OR (llm.safety_severity in {possible,clear} AND llm.safety_is_caregiving)
 *           -> urgency P0, classification "safeguarding", escalation {reason, "P0"}.
 *   Step 2  llm.safety_severity in {possible,clear} AND NOT caregiving -> P1 (escalation may be {.,"P1"} or null).
 *   Step 3  operational accumulator (baseline P2):
 *             +2 same-day operational (time_sensitivity==same_day OR regex.same_day_hit, with a concrete today-action)
 *             +1 complaint w/ time element ; -1 fyi_only & !requires_action ; -2 spam.
 *             urgent_words = 0. Threshold: >=2 -> P1 ; [-1,1] -> P2 ; <=-2 -> P3.
 *   Step 4  final classification: llm proposal as prior, overridden by structure
 *           (blank required referral fields -> missing_paperwork; known active patient -> existing_patient_request).
 * requires_human_review is ALWAYS true (validator requires it). rationale_signals lists every
 * fired signal + weight + final score + source, for decision_rationale.
 */
export interface ScoreResult {
  urgency: Urgency;
  classification: Classification;
  gate: Gate;
  requires_human_review: boolean;
  /** Proposed review reason. This is not proof of any delivered notification. */
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  rationale_signals: string[];
}

export type ScoreUrgency = (bundle: SignalBundle) => ScoreResult;

/**
 * ORCHESTRATE (orchestrate.ts): executes the relevant local synthetic tools (search_patient,
 * verify_insurance, lookup_policy, find_slots, create_task, draft_message, escalate) for the
 * item. CALLED INSIDE withItemContext(item.id, ...) by agent.ts, so every tool call is recorded
 * under this item. Rules: call each tool you intend to surface exactly ONCE, no performative
 * calls, never hold_slot on out-of-network/expired, compose draft TEXT here (the draft_reply
 * string), and call escalate() iff score.escalation !== null. Do NOT read getToolCallsForItem
 * (assemble does that). Returns the artifacts assemble needs.
 */
export interface OrchestrationResult {
  /** task_id values returned by create_task calls. */
  task_ids: string[];
  /** The drafted message text (also passed as draft_message body), or null if no draft. */
  draft_reply: string | null;
  recommended_next_action: string;
  missing_info: string[];
  /** Local evidence notes folded into decision_rationale. */
  notes: string[];
}

export type Orchestrate = (
  item: InboxItem,
  bundle: SignalBundle,
  score: ScoreResult,
) => Promise<OrchestrationResult>;

/**
 * ASSEMBLE (assemble.ts): build the final schema-valid ItemOutput.
 * tools_called MUST be getToolCallsForItem(item.id) passed through UNCHANGED (no edits to
 * call_id/name/args/result_summary). escalation = score.escalation. decision_rationale composes
 * score.rationale_signals + orchestration.notes + a short classification justification.
 * extracted_intake comes from bundle.llm.extracted_intake (discipline: non-empty array or null,
 * never []). requires_human_review = true.
 */
export type AssembleItemOutput = (
  item: InboxItem,
  bundle: SignalBundle,
  score: ScoreResult,
  orchestration: OrchestrationResult,
) => ItemOutput;
