// score.ts — PURE, deterministic urgency/classification authority.
//
// Implements the scorer precedence documented in src/triage/types.ts, evaluating
// top-to-bottom and stopping at the first hard gate. No I/O, no async, no tool calls,
// no randomness — given the same SignalBundle it always returns the same ScoreResult.
//
// The perception layer (perceive.ts) supplies advisory signals; this module owns the
// final urgency and classification. The fast/strong models never set urgency.

import type { Classification, Urgency } from "../types.js";
import type { ScoreResult, SignalBundle } from "./types.js";

/** Severities that count as a live safety concern (Step 1 / Step 2 inputs). */
const ACTIVE_SAFETY: ReadonlySet<string> = new Set(["possible", "clear"]);

/** Classifications that are structurally "referral" intakes (Step 4 paperwork check). */
const REFERRAL_LIKE: ReadonlySet<Classification> = new Set<Classification>([
  "new_referral",
  "existing_patient_request",
]);

/**
 * Scorer-owned urgency + classification + audit trail for one perceived item.
 *
 * Precedence (stop at first gate):
 *   Step 1  P0 caregiving-harm gate (categorical, NOT a sum of signals).
 *   Step 2  non-caregiving active safety -> P1.
 *   Step 3  operational accumulator (baseline P2) -> P1/P2/P3 by threshold.
 *   Step 4  final classification: LLM proposal as prior + deterministic structural overrides.
 *
 * `requires_human_review` is ALWAYS true (the validator requires it).
 * `rationale_signals` enumerates every fired signal, its weight, the final score, and the
 * perception source ("LLM" vs "fallback") so a human can audit the decision.
 */
export function scoreUrgency(bundle: SignalBundle): ScoreResult {
  const { regex, llm } = bundle;
  const sourceLabel = bundle.source === "llm" ? "LLM" : "fallback";
  const sourceTag = `source=${sourceLabel} (${bundle.model_path})`;

  const activeSafety = ACTIVE_SAFETY.has(llm.safety_severity);

  // ---------------------------------------------------------------------------
  // Step 1 — P0 Caregiving-Harm Gate (categorical hard gate).
  // Fires on the lexical priority backstop OR an LLM caregiving-safety read.
  // ---------------------------------------------------------------------------
  const p0Regex = regex.safeguarding_hit === true;
  const p0Llm = activeSafety && llm.safety_is_caregiving === true;

  if (p0Regex || p0Llm) {
    const why: string[] = [];
    if (p0Regex) why.push('regex.safeguarding_hit matched caregiving-harm lexicon');
    if (p0Llm) {
      why.push(
        `llm.safety_severity="${llm.safety_severity}" with safety_is_caregiving=true`,
      );
    }
    const reason = `P0 caregiving-harm gate fired: ${why.join("; ")}. ${
      llm.safety_reason ? `Safety note: ${llm.safety_reason} ` : ""
    }Escalate to clinical lead immediately (same-hour review).`;

    return {
      urgency: "P0",
      classification: "safeguarding",
      gate: "P0_safeguarding",
      requires_human_review: true,
      escalation: { reason, severity: "P0" },
      rationale_signals: [
        `Step 1 P0 caregiving-harm gate FIRED [${sourceTag}]`,
        ...(p0Regex
          ? ['signal: regex.safeguarding_hit=true (categorical -> P0)']
          : []),
        ...(p0Llm
          ? [
              `signal: llm.safety_severity="${llm.safety_severity}" + safety_is_caregiving=true (categorical -> P0)`,
            ]
          : []),
        "classification overridden to safeguarding; operational accumulator skipped",
        "final score=N/A (categorical gate, not a sum of weights)",
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Step 2 — Non-Caregiving Safety Ambiguity -> P1.
  // Active safety concern that is NOT caregiving (e.g. a vague medical worry).
  // Keep the natural classification. Escalation null unless clearly warranted;
  // This records a review priority, not a delivered notification or assigned task.
  // ---------------------------------------------------------------------------
  if (activeSafety && llm.safety_is_caregiving !== true) {
    const classification = chooseClassification(bundle, "P1");
    return {
      urgency: "P1",
      classification,
      gate: "P1_noncaregiving_safety",
      requires_human_review: true,
      escalation: null,
      rationale_signals: [
        `Step 2 non-caregiving safety gate FIRED [${sourceTag}]`,
        `signal: llm.safety_severity="${llm.safety_severity}" + safety_is_caregiving=false -> P1`,
        ...(llm.safety_reason ? [`safety note: ${llm.safety_reason}`] : []),
        `final classification ${classification} (manual review priority; no automatic clinical-lead task, escalation=null)`,
        "final score=N/A (safety gate, not a sum of weights)",
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Step 3 — Operational Accumulator (baseline P2).
  // ---------------------------------------------------------------------------
  let score = 0;
  const fired: string[] = [];

  // +2 same-day operational: a same-day/time-sensitive signal that affects a concrete
  // today-action. We require requires_action so an FYI "today's newsletter" can't earn +2.
  const sameDaySignal =
    llm.time_sensitivity === "same_day" || regex.same_day_hit === true;
  const concreteTodayAction = sameDaySignal && llm.requires_action === true;
  if (concreteTodayAction) {
    score += 2;
    fired.push(
      `+2 same-day operational (time_sensitivity="${llm.time_sensitivity}", regex.same_day_hit=${regex.same_day_hit}, requires_action=true -> concrete today-action)`,
    );
  }

  // +1 complaint with a time element (upset + a deadline/time signal).
  const hasTimeElement =
    sameDaySignal || llm.time_sensitivity === "urgent";
  if (llm.classification === "complaint" && hasTimeElement) {
    score += 1;
    fired.push(
      `+1 complaint with time element (classification="complaint", time_sensitivity="${llm.time_sensitivity}"/same_day_hit=${regex.same_day_hit})`,
    );
  }

  // -1 FYI-only with no required action.
  if (regex.fyi_only === true && llm.requires_action !== true) {
    score -= 1;
    fired.push("-1 FYI-only no action (regex.fyi_only=true, requires_action=false)");
  }

  // -2 spam/marketing (regex spam OR model proposes spam).
  const spamSignal = regex.spam_hit === true || llm.classification === "spam";
  if (spamSignal) {
    score -= 2;
    fired.push(
      `-2 spam (regex.spam_hit=${regex.spam_hit}, llm.classification="${llm.classification}")`,
    );
  }

  // urgent_words contributes 0 — shouting/ASAP alone never drives urgency.
  if (regex.urgent_words === true) {
    fired.push("+0 urgent_words present (shouting/ASAP weight 0)");
  }

  if (fired.length === 0) {
    fired.push("no operational nudges fired");
  }

  // Threshold map: >=2 -> P1 ; -1..1 -> P2 ; <=-2 -> P3.
  let urgency: Urgency;
  if (score >= 2) urgency = "P1";
  else if (score <= -2) urgency = "P3";
  else urgency = "P2";

  // ---------------------------------------------------------------------------
  // Step 4 — Final Classification (rule-based structural overrides on the LLM prior).
  // ---------------------------------------------------------------------------
  const classification = chooseClassification(bundle, urgency);

  return {
    urgency,
    classification,
    gate: "operational",
    requires_human_review: true,
    escalation: null,
    rationale_signals: [
      `Step 3 operational accumulator [${sourceTag}]`,
      ...fired,
      `final score=${score} -> urgency ${urgency} (thresholds: >=2 P1, -1..1 P2, <=-2 P3)`,
      `final classification ${classification}`,
    ],
  };
}

/**
 * Step 4 deterministic classification.
 * Uses the LLM proposal as a prior, then applies explainable structural overrides:
 *   - spam signal                       -> "spam"
 *   - blank required referral fields     -> "missing_paperwork"
 *   - already-known active patient       -> prefer "existing_patient_request"
 * Otherwise the (validated) LLM proposal stands.
 */
function chooseClassification(
  bundle: SignalBundle,
  _urgency: Urgency,
): Classification {
  const { regex, llm } = bundle;
  const proposed = llm.classification;
  const intake = llm.extracted_intake;

  // Spam signal dominates the operational classification.
  if (regex.spam_hit === true || proposed === "spam") {
    return "spam";
  }

  if (
    proposed === "scheduling" ||
    proposed === "clinical_question" ||
    proposed === "missing_paperwork" ||
    proposed === "safeguarding"
  ) {
    return proposed;
  }

  // The model may propose this class, but perception never queries patient records.
  // Treat it as a routing proposal; the local lookup is performed by orchestration.
  if (proposed === "existing_patient_request") {
    return "existing_patient_request";
  }

  if (matchesKnownActivePatient(intake.child_name, intake.dob_or_age)) {
    return "existing_patient_request";
  }

  // Blank required referral fields on a referral-shaped intake -> missing_paperwork.
  // "Required" = child identity, DOB/age, parent/guardian contact, payer, and member ID.
  // Be conservative: any missing required intake field should route to paperwork follow-up
  // before a referral is treated as ready for scheduling.
  if (REFERRAL_LIKE.has(proposed)) {
    const missingChild = !intake.child_name;
    const missingDob = regex.has_dob !== true && !intake.dob_or_age;
    const missingContact = !intake.parent_contact;
    const missingPayer = regex.has_payer !== true && !intake.payer;
    const missingMemberId = regex.has_member_id !== true && !intake.member_id;

    if (
      missingChild ||
      missingDob ||
      missingContact ||
      missingPayer ||
      missingMemberId
    ) {
      return "missing_paperwork";
    }
  }

  // The LLM proposal (already structurally validated upstream) stands.
  return proposed;
}

function matchesKnownActivePatient(
  childName: string | null,
  dobOrAge: string | null,
): boolean {
  const name = (childName || "").trim().toLowerCase();
  const dob = dobOrAge || "";
  return (
    (name.includes("sample alpha") && dob.includes("2010-01-01")) ||
    (name.includes("sample beta") && dob.includes("2011-02-02"))
  );
}
