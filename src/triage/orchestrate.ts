// ORCHESTRATE (orchestrate.ts) — deterministic tool routing for one inbox item.
//
// Called by agent.ts INSIDE withItemContext(item.id, () => orchestrate(item, bundle, score)),
// so every local synthetic tool call is recorded under this item. Therefore:
//   - call each tool we intend to surface EXACTLY ONCE (no performative/duplicate calls);
//   - NEVER call hold_slot (all slot options require human review, and a hold is
//     categorically forbidden on out_of_network / expired insurance);
//   - call escalate() IFF score.escalation !== null (P0 gate; optionally Step-2 P1);
//   - compose draft TEXT here and return it as draft_reply (also passed as draft_message body);
//   - do NOT call withItemContext (caller does) and do NOT read getToolCallsForItem (assemble does).
//
// Routing is by score.classification (the final, structurally-corrected class) with the P0
// safeguarding gate taking precedence. Logic is rule-driven off the perceived intake fields so
// routes are selected by classification, not inbox item IDs. No external actions occur.

import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  lookup_policy,
  search_patient,
  verify_insurance,
} from "../tools.js";
import type { Discipline, InboxItem } from "../types.js";
import type { OrchestrationResult, ScoreResult, SignalBundle } from "./types.js";

export async function orchestrate(
  item: InboxItem,
  bundle: SignalBundle,
  score: ScoreResult,
): Promise<OrchestrationResult> {
  const intake = bundle.llm.extracted_intake;
  const notes: string[] = [];
  const task_ids: string[] = [];

  const childName = intake.child_name?.trim() || null;
  const discipline = firstDiscipline(intake.discipline);
  const payer = intake.payer?.trim() || null;
  const memberId = intake.member_id?.trim() || null;
  const language: "en" | "es" = isSpanish(item) ? "es" : "en";
  const recipient = chooseRecipient(item, intake);
  const channel = chooseChannel(item.channel);
  const today = isoDate(item.received_at);

  // ── P0 safeguarding gate ──────────────────────────────────────────────────
  // Highest precedence: escalate, ground in policy, same-hour clinical-lead task,
  // and a strictly NEUTRAL acknowledgement (no investigative/clinical/legal advice,
  // no promised outcome).
  if (score.gate === "P0_safeguarding") {
    if (score.escalation) {
      await escalate({
        item_id: item.id,
        reason: score.escalation.reason,
        severity: score.escalation.severity,
      });
    }

    await lookup_policy({ topic: "safeguarding" });

    const task = await create_task({
      assignee: "clinical_lead",
      title: `Same-hour safeguarding review${childName ? ` for ${childName}` : ""}`,
      due: sameHourDue(item.received_at),
      notes:
        "Inbound message contains a possible unsafe-caregiving disclosure. Per policy this is P0: " +
        "clinical lead to review immediately and determine next steps. Neutral acknowledgement only " +
        "has been drafted; no investigative advice provided.",
    });
    task_ids.push(task.data.task_id);

    const draft =
      `Hi${parentSalutation(item, intake)}, thank you for your message. ` +
      `It needs prompt staff review. This is an unsent demonstration draft, not confirmation of a response.`;

    await draft_message({ recipient, channel, body: draft, language });

    notes.push("safety: P0 safeguarding gate - local clinical-lead review request recorded; nobody notified");
    notes.push("draft: neutral acknowledgement only (no investigative/clinical advice)");

    return {
      task_ids,
      draft_reply: draft,
      recommended_next_action:
        "Clinical lead must review this safeguarding disclosure immediately (same-hour) and decide next steps; do not act on scheduling until reviewed.",
      missing_info: [],
      notes,
    };
  }

  // For all non-P0 routes, escalate only if the scorer asked for it (e.g. a Step-2 P1).
  if (score.escalation) {
    await escalate({
      item_id: item.id,
      reason: score.escalation.reason,
      severity: score.escalation.severity,
    });
    notes.push(`escalation: ${score.escalation.severity} - ${score.escalation.reason}`);
  }

  switch (score.classification) {
    case "scheduling":
      return scheduling();
    case "new_referral":
      return newReferral();
    case "existing_patient_request":
      return existingPatientRequest();
    case "clinical_question":
      return clinicalQuestion();
    case "missing_paperwork":
      return missingPaperwork();
    case "billing_question":
      return billingQuestion();
    case "spam":
      return passive("No action: classified as spam/marketing; no outbound draft.");
    default:
      // complaint / provider_followup / other — acknowledge and route to a human.
      return defaultAcknowledge();
  }

  // ── same-day scheduling (P1) ────────────────────────────────────────────────
  async function scheduling(): Promise<OrchestrationResult> {
    const patient = await maybeSearchPatient();
    await lookup_policy({ topic: "scheduling" });

    const task = await create_task({
      assignee: "front_desk",
      title: `Same-day scheduling follow-up${childName ? ` for ${childName}` : ""}`,
      due: today,
      notes:
        `Family requests a same-day cancellation/reschedule${childName ? ` for ${childName}` : ""}. ` +
        "Front desk to contact the family today and arrange a new time per capacity. " +
        "Do not auto-reschedule; staff review required.",
    });
    task_ids.push(task.data.task_id);

    const draft =
      `Hi${parentSalutation(item, intake)}, thank you for letting us know. We have received your request to ` +
      `change today's appointment and our front desk team will reach out shortly to confirm a new time. ` +
      `There is nothing further you need to do right now.`;
    await draft_message({ recipient, channel, body: draft, language });

    notes.push("scheduling: same-day operational P1 - local front_desk task draft recorded (no auto-reschedule)");
    if (patient) notes.push(`patient: matched active record ${patient}`);

    return {
      task_ids,
      draft_reply: draft,
      recommended_next_action:
        "Front desk to contact the family today and arrange a replacement slot per provider capacity; do not auto-reschedule.",
      missing_info: [],
      notes,
    };
  }

  // ── new referral ────────────────────────────────────────────────────────────
  async function newReferral(): Promise<OrchestrationResult> {
    const ins = await maybeVerifyInsurance();

    if (ins && (ins.status === "out_of_network" || ins.status === "expired")) {
      // Billing workflow BEFORE any scheduling; never hold a slot here.
      await lookup_policy({ topic: "insurance" });
      const task = await create_task({
        assignee: "billing",
        title: `Review ${ins.status === "expired" ? "expired" : "out-of-network"} coverage${childName ? ` for ${childName}` : ""}`,
        due: dueInDays(item.received_at, 2),
        notes:
          `${payer ?? "Payer"} synthetic lookup returned ${ins.status} for ${childName ?? "this child"}. ` +
          (ins.status === "expired"
            ? "Coverage fixture is expired; staff would need to confirm current coverage. "
            : "Benefits conversation required before any slot hold or scheduling step. ") +
          "Do not hold or schedule a slot until billing follows up.",
      });
      task_ids.push(task.data.task_id);

      const draft =
        `Hi${parentSalutation(item, intake)}, thank you for sending ${childName ? `${childName}'s` : "the"} referral. ` +
        `Before we schedule, our billing team needs to review the ${payer ?? "insurance"} plan because it appears ` +
        `to be ${ins.status === "expired" ? "expired in the synthetic fixture" : "out of network in the synthetic fixture"}. ` +
        `A team member will follow up with the available options.`;
      await draft_message({ recipient, channel, body: draft, language });

      notes.push(`insurance: ${ins.status}${payer ? ` (${payer})` : ""}`);
      notes.push("scheduling: deferred - benefits conversation required before any slot");

      return {
        task_ids,
        draft_reply: draft,
        recommended_next_action: `Billing to review ${ins.status === "expired" ? "expired coverage" : "out-of-network benefits"} with the family before any scheduling step.`,
        missing_info: [],
        notes,
      };
    }

    // In-network (or unknown/no payer): surface reviewable slots, acknowledge, give next step.
    if (ins) notes.push(`insurance: ${ins.status}${payer ? ` (${payer})` : ""}`);
    const slots = await maybeFindSlots();

    const draft =
      language === "es"
        ? spanishReferralDraft(childName, discipline, !!slots)
        : `Hi${parentSalutation(item, intake)}, thank you for ${childName ? `${childName}'s` : "the"} referral for ` +
          `${disciplineLabel(discipline)} services. We have the information we need to move forward, and a team member ` +
          `will be in touch to confirm an evaluation time` +
          `${slots ? " from our next available openings" : ""}. ` +
          (ins?.auth_required ? "We will also confirm any prior-authorization requirements with your plan. " : "");

    await draft_message({ recipient, channel, body: draft, language });

    if (ins?.auth_required) notes.push("insurance: prior authorization required");
    if (language === "es") notes.push("language: Spanish-language family - Spanish draft + Spanish-capable provider search");

    return {
      task_ids,
      draft_reply: draft,
      recommended_next_action: slots
        ? "Staff to confirm an evaluation slot from the surfaced options with the family."
        : "Staff to follow up to confirm an evaluation time for the family.",
      missing_info: [],
      notes,
    };
  }

  // ── existing patient request ──────────────────────────────────────────────
  async function existingPatientRequest(): Promise<OrchestrationResult> {
    const patient = await maybeSearchPatient();
    if (patient) notes.push(`patient: matched active record ${patient}`);

    const ins = await maybeVerifyInsurance();
    if (ins) notes.push(`insurance: ${ins.status}${payer ? ` (${payer})` : ""}`);

    if (ins && (ins.status === "out_of_network" || ins.status === "expired")) {
      await lookup_policy({ topic: "insurance" });
      const task = await create_task({
        assignee: "billing",
        title: `Review ${ins.status === "expired" ? "expired" : "out-of-network"} coverage${childName ? ` for ${childName}` : ""}`,
        due: dueInDays(item.received_at, 2),
        notes:
          `${payer ?? "Payer"} synthetic lookup returned ${ins.status} for ${childName ?? "this patient"}. ` +
          "Billing to confirm benefits before any scheduling step. Do not hold or schedule a slot.",
      });
      task_ids.push(task.data.task_id);
      notes.push("scheduling: deferred - benefits conversation required before any slot");
    } else {
      await maybeFindSlots();
      if (ins?.auth_required) notes.push("insurance: prior authorization required");
    }

    const draft =
      `Hi${parentSalutation(item, intake)}, thank you for reaching out about ${childName ?? "your child"}. ` +
      (patient ? `The synthetic lookup returned a record; staff must confirm the requested ` : `Staff must confirm the patient record before coordinating the requested `) +
      `${disciplineLabel(discipline)} ${discipline ? "evaluation" : "visit"}` +
      `${ins?.auth_required ? ", including confirming any prior-authorization requirements" : ""}.`;
    await draft_message({ recipient, channel, body: draft, language });

    return {
      task_ids,
      draft_reply: draft,
      recommended_next_action:
        "Staff to coordinate the requested visit for the existing patient and confirm any authorization needs.",
      missing_info: [],
      notes,
    };
  }

  // ── clinical question ─────────────────────────────────────────────────────
  // Empathetic, NO clinical/developmental advice, route to screening/evaluation.
  async function clinicalQuestion(): Promise<OrchestrationResult> {
    await lookup_policy({ topic: "clinical_advice" });
    await maybeFindSlots(); // surface a screening/eval path without giving advice

    const draft =
      language === "es"
        ? `Hola${parentSalutation(item, intake)}, gracias por su mensaje. Entendemos su preocupacion. No podemos ofrecer ` +
          `consejo clinico por mensaje, pero con gusto le ayudamos a programar una evaluacion o un cribado con uno de ` +
          `nuestros especialistas para responder sus preguntas. Un miembro del equipo se comunicara con usted.`
        : `Hi${parentSalutation(item, intake)}, thank you for reaching out. We understand the concern. ` +
          `We're not able to give clinical advice by message, but the best next step is a brief screening or evaluation with one ` +
          `of the appropriate clinicians. Staff must review this unsent draft and the proposed next step.`;
    await draft_message({ recipient, channel, body: draft, language });

    notes.push("clinical: question routed to screening/evaluation; no clinical advice given in draft");

    return {
      task_ids,
      draft_reply: draft,
      recommended_next_action:
        "Offer the family a screening/evaluation with a clinician; do not provide clinical advice by message.",
      missing_info: [],
      notes,
    };
  }

  // ── missing paperwork ─────────────────────────────────────────────────────
  async function missingPaperwork(): Promise<OrchestrationResult> {
    const missing_info = computeMissingInfo();

    const task = await create_task({
      assignee: "intake",
      title: `Obtain missing referral details${childName ? ` for ${childName}` : ""}`,
      due: dueInDays(item.received_at, 2),
      notes:
        `Referral${childName ? ` for ${childName}` : ""} is missing required fields: ` +
        `${missing_info.length ? missing_info.join("; ") : "intake details"}. ` +
        "Intake to request the missing information from the referring provider before scheduling.",
    });
    task_ids.push(task.data.task_id);

    const draft =
      `Hello, thank you for the referral${childName ? ` for ${childName}` : ""}. Before we can schedule an evaluation we ` +
      `need a few missing details: ${missing_info.length ? missing_info.join(", ") : "the remaining intake fields"}. ` +
      `Could you please send these over at your earliest convenience? We'll move forward as soon as we receive them.`;
    await draft_message({
      recipient,
      channel,
      body: draft,
      language,
    });

    notes.push(`missing_paperwork: requesting ${missing_info.length} field(s) from referring provider`);

    return {
      task_ids,
      draft_reply: draft,
      recommended_next_action:
        "Intake to obtain the missing referral fields from the referring provider before scheduling.",
      missing_info,
      notes,
    };
  }

  // ── billing question ──────────────────────────────────────────────────────
  async function billingQuestion(): Promise<OrchestrationResult> {
    const ins = await maybeVerifyInsurance();
    if (ins) notes.push(`insurance: ${ins.status}${payer ? ` (${payer})` : ""}`);
    await lookup_policy({ topic: "insurance" });

    const task = await create_task({
      assignee: "billing",
      title: `Billing follow-up${childName ? ` for ${childName}` : ""}`,
      due: dueInDays(item.received_at, 2),
      notes:
        `Billing question received${payer ? ` regarding ${payer}` : ""}` +
        `${ins ? ` (synthetic fixture status: ${ins.status})` : ""}. Billing review is proposed.`,
    });
    task_ids.push(task.data.task_id);

    const draft =
      `Hi${parentSalutation(item, intake)}, thank you for your message. Our billing team will review your question` +
      `${payer ? ` about your ${payer} coverage` : ""} and follow up with you directly.`;
    await draft_message({ recipient, channel, body: draft, language });

    return {
      task_ids,
      draft_reply: draft,
      recommended_next_action: "Billing to review the coverage question and follow up with the family.",
      missing_info: [],
      notes,
    };
  }

  // ── spam / passive ────────────────────────────────────────────────────────
  async function passive(reason: string): Promise<OrchestrationResult> {
    notes.push(reason);
    return {
      task_ids,
      draft_reply: null,
      recommended_next_action: "No outbound action required; flagged for human review.",
      missing_info: [],
      notes,
    };
  }

  // ── default acknowledge (complaint / provider_followup / other) ────────────
  async function defaultAcknowledge(): Promise<OrchestrationResult> {
    const task = await create_task({
      assignee: "front_desk",
      title: `Review and follow up${childName ? ` re: ${childName}` : ""}`,
      due: dueInDays(item.received_at, 2),
      notes: "Inbound message requires staff review and follow-up.",
    });
    task_ids.push(task.data.task_id);

    const draft =
      `Hi${parentSalutation(item, intake)}, thank you for your message. We have received it and a member of our team ` +
      `will follow up with you shortly.`;
    await draft_message({ recipient, channel, body: draft, language });

    notes.push("routing: local front-desk task and unsent acknowledgement drafts recorded");

    return {
      task_ids,
      draft_reply: draft,
      recommended_next_action: "Staff to review the message and follow up with the sender.",
      missing_info: [],
      notes,
    };
  }

  // ── helpers that themselves call tools (each at most once per item) ─────────
  async function maybeSearchPatient(): Promise<string | null> {
    if (!childName) return null;
    const dob = dobFromIntake(intake.dob_or_age);
    const res = await search_patient(dob ? { name: childName, dob } : { name: childName });
    const found = res.data[0];
    return found ? `${found.name} (${found.patient_id})` : null;
  }

  async function maybeVerifyInsurance() {
    if (!payer) return null;
    const res = await verify_insurance(memberId ? { payer, member_id: memberId } : { payer });
    return res.data;
  }

  async function maybeFindSlots() {
    // Surface reviewable options. Pass language only when Spanish so non-Spanish
    // items aren't over-filtered. Discipline filters when known.
    const args: { discipline?: Discipline; language?: string } = {};
    if (discipline) args.discipline = discipline;
    if (language === "es") args.language = "es";
    const res = await find_slots(args);
    return res.data.length > 0 ? res.data : null;
  }

  function computeMissingInfo(): string[] {
    const missing: string[] = [];
    if (!intake.child_name) missing.push("child name");
    if (!intake.dob_or_age) missing.push("date of birth");
    if (!intake.parent_contact) missing.push("parent/guardian name and contact");
    if (!intake.payer) missing.push("insurance payer");
    if (!intake.member_id) missing.push("member ID");
    return missing;
  }
}

// ── pure helpers (no tool calls) ──────────────────────────────────────────────

function firstDiscipline(d: Discipline[] | null): Discipline | null {
  return d && d.length > 0 ? d[0] : null;
}

function disciplineLabel(d: Discipline | null): string {
  switch (d) {
    case "SLP":
      return "speech-language";
    case "OT":
      return "occupational therapy";
    case "PT":
      return "physical therapy";
    default:
      return "therapy";
  }
}

/** Spanish detection from raw item text (accent markers, greeting, "espanol"). */
function isSpanish(item: InboxItem): boolean {
  const text = `${item.subject} ${item.body}`.toLowerCase();
  const markers = [
    "espanol",
    "español",
    "hola",
    "gracias",
    "evaluacion",
    "evaluación",
    "mensaje de voz",
    "soy ",
    " mi hija",
    " mi hijo",
    "necesita una",
    "prefiero alguien que hable",
  ];
  return markers.some((m) => text.includes(m));
}

/** Prefer an email address if present; else parent contact; else the sender label. */
function chooseRecipient(item: InboxItem, intake: { parent_contact: string | null }): string {
  const fromSender = extractEmail(item.sender);
  if (fromSender) return fromSender;
  const fromBody = extractEmail(item.body);
  if (fromBody) return fromBody;
  if (intake.parent_contact) return intake.parent_contact;
  return item.sender;
}

function extractEmail(s: string): string | null {
  const m = s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}

function chooseChannel(channel: InboxItem["channel"]): "portal" | "email" | "phone" {
  switch (channel) {
    case "email":
      return "email";
    case "portal_message":
      return "portal";
    case "voicemail_transcript":
      return "phone";
    case "fax_referral":
      return "email"; // outbound to a referring provider / parent is best done by email
    default:
      return "email";
  }
}

/** A salutation fragment from a leading capitalized word; empty when absent. */
function parentSalutation(item: InboxItem, intake: { parent_contact: string | null }): string {
  const name = parentFirstName(intake.parent_contact) ?? parentFirstName(item.sender);
  return name ? ` ${name}` : "";
}

function parentFirstName(s: string | null): string | null {
  if (!s) return null;
  // Strip emails/angle brackets and grab a leading capitalized word.
  const cleaned = s.replace(/<[^>]*>/g, " ").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, " ");
  const m = cleaned.match(/[A-Z][a-z]+/);
  return m ? m[0] : null;
}

/** Extract a YYYY-MM-DD DOB from the intake dob_or_age field, if present. */
function dobFromIntake(dobOrAge: string | null): string | undefined {
  if (!dobOrAge) return undefined;
  const m = dobOrAge.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : undefined;
}

/** YYYY-MM-DD date portion of an ISO timestamp (the item's received_at "today"). */
function isoDate(receivedAt: string): string {
  const m = receivedAt.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  return new Date().toISOString().slice(0, 10);
}

/** Same-hour due timestamp: keep the received hour, used for P0 clinical-lead tasks. */
function sameHourDue(receivedAt: string): string {
  const d = new Date(receivedAt);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

/** YYYY-MM-DD that is `days` after the received date. */
function dueInDays(receivedAt: string, days: number): string {
  const base = new Date(isoDate(receivedAt) + "T00:00:00Z");
  if (Number.isNaN(base.getTime())) {
    const fallback = new Date();
    fallback.setUTCDate(fallback.getUTCDate() + days);
    return fallback.toISOString().slice(0, 10);
  }
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function spanishReferralDraft(
  childName: string | null,
  discipline: Discipline | null,
  hasSlots: boolean,
): string {
  const disc =
    discipline === "SLP"
      ? "de habla"
      : discipline === "OT"
      ? "de terapia ocupacional"
      : discipline === "PT"
      ? "de terapia fisica"
      : "de terapia";
  return (
    `Hola, gracias por su mensaje${childName ? ` por ${childName}` : ""}. ` +
    `Tenemos la informacion necesaria para continuar y un miembro de nuestro equipo se comunicara con usted ` +
    `para coordinar una evaluacion ${disc} con un proveedor que hable espanol` +
    `${hasSlots ? ", de acuerdo con nuestras proximas citas disponibles" : ""}. Gracias por su paciencia.`
  );
}
