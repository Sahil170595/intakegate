// perceive.ts — targeted cascade (regex always + LLM fast/strong) -> SignalBundle.
//
// This module is the PERCEPTION layer only. It is advisory: it extracts intake fields,
// proposes a classification, and flags safety/time/action signals. It NEVER decides final
// urgency, NEVER chooses tools, NEVER touches call_ids, and NEVER imports src/tools.ts (so it
// creates no audit-trace entry). The scorer/orchestrator own all final decisions.
//
// Architecture:
//   1. REGEX LAYER — deterministic, always runs, fills RegexSignals over subject+body.
//   2. LLM CASCADE — explicit opt-in plus API key; strong model only
//      when the fast result is high-stakes/uncertain. Forced JSON via single tool-use tool.
//   3. KEYLESS FALLBACK — no key / timeout / error: fill PerceptionSignals from regex+heuristics.
//
// Conforms exactly to the `Perceive` type in ./types.ts.

import Anthropic from "@anthropic-ai/sdk";
import { Ajv } from "ajv";
import type {
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
} from "../types.js";
import type {
  PerceptionSignals,
  Perceive,
  RegexSignals,
  SafetySeverity,
  SignalBundle,
  TimeSensitivity,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Each tier has its own abort budget; a slow fast tier must not consume the strong tier's budget.
const PER_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_FAST_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_STRONG_MODEL = "claude-sonnet-4-6";
const TRIAGE_TOOL_NAME = "emit_triage_signals";

// ---------------------------------------------------------------------------
// Lexicons (heuristic; negation/context false positives remain)
// ---------------------------------------------------------------------------

// Caregiving-harm lexicon. Single words use word boundaries; multiword phrases
// are matched as substrings on the normalized text.
const SAFEGUARDING_WORDS = [
  "hit",
  "hitting",
  "hits",
  "beat",
  "beats",
  "beating",
  "slap",
  "slaps",
  "slapped",
  "slapping",
  "punch",
  "punched",
  "punching",
  "shove",
  "shoved",
  "shoving",
  "abuse",
  "abused",
  "abusive",
  "neglect",
  "neglected",
  "neglectful",
  "bruise",
  "bruised",
  "bruises",
  "welt",
  "welts",
];

const SAFEGUARDING_PHRASES = [
  "getting rough",
  "rough with",
  "rough handling",
  "injury caused by",
  "scared to go home",
  "afraid to go home",
  "unsafe at home",
  "afraid of dad",
  "afraid of father",
  "afraid of mom",
  "afraid of mother",
  "afraid of uncle",
  "scared of dad",
  "scared of father",
  "scared of mom",
  "scared of mother",
  "scared of uncle",
  "doesn't want to go with dad",
  "does not want to go with dad",
  "doesn't want to go with father",
  "does not want to go with father",
  "cries when dad",
  "cries when father",
  "flinches when dad",
  "flinches when father",
  "flinches when uncle",
  "cowers when dad",
  "cowers when father",
  "cowers when uncle",
  "dad grabbed",
  "father grabbed",
  "mom grabbed",
  "mother grabbed",
  "uncle grabbed",
  "grabbed by dad",
  "grabbed by father",
  "grabbed by mom",
  "grabbed by mother",
  "grabbed by uncle",
  "left alone",
  "not being fed",
  "not fed",
  "locked in",
  "locked out",
  "touched inappropriately",
  "hurts him",
  "hurts her",
  "hurting him",
  "hurting her",
];

// Temporal-urgency lexicon. Phrases that anchor an action to "today" / same-day.
const SAME_DAY_PHRASES = [
  "today",
  "this morning",
  "this afternoon",
  "this evening",
  "tonight",
  "same-day",
  "same day",
  "by end of day",
  "by eod",
  "right now",
];

// Shout markers. Weight 0 in the scorer; tracked only for rationale.
const URGENT_WORDS = ["urgent", "asap", "emergency", "immediately"];

// Marketing/spam lexicon — precise to avoid flagging legitimate referrals.
const SPAM_PHRASES = [
  "unsubscribe",
  "limited time offer",
  "act now",
  "click here",
  "special offer",
  "buy now",
  "free trial",
  "discount code",
  "promo code",
  "winner",
  "congratulations you",
  "risk-free",
  "best rates",
  "marketing",
  "newsletter",
  "% off",
];

// Acknowledgement/FYI markers (no request verb). Precise: only fire when the message reads as a
// notice, not a request.
const FYI_PHRASES = [
  "fyi",
  "for your information",
  "just so you know",
  "no action needed",
  "no action required",
  "no response needed",
  "just confirming",
  "just letting you know",
  "heads up",
  "thanks for",
  "thank you for",
];

// Verbs that signal an actual request (suppress fyi_only when present).
const REQUEST_VERBS = [
  "please",
  "can we",
  "can you",
  "could you",
  "would you",
  "need",
  "needs",
  "want",
  "looking for",
  "reschedule",
  "cancel",
  "book",
  "schedule",
  "evaluate",
  "eval",
  "referral",
  "refer",
  "question",
  "ask",
  "?",
];

// Discipline cue lexicon for keyless extraction/classification.
const DISCIPLINE_CUES: Array<{ d: Discipline; cues: string[] }> = [
  {
    d: "SLP",
    cues: [
      "slp",
      "speech",
      "speech therapy",
      "speech-language",
      "language delay",
      "articulation",
      "intelligibility",
      "stutter",
      "habla", // Spanish cue
      "lenguaje",
    ],
  },
  {
    d: "OT",
    cues: [
      "ot",
      "occupational",
      "sensory",
      "sensory processing",
      "feeding",
      "fine motor",
      "self-regulation",
    ],
  },
  {
    d: "PT",
    cues: [
      "pt",
      "physical therapy",
      "gross motor",
      "toe walking",
      "tripping",
      "gait",
      "balance",
      "walking",
    ],
  },
];

// ---------------------------------------------------------------------------
// Regex layer
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return (s ?? "").toLowerCase();
}

function hasWord(haystack: string, word: string): boolean {
  // \b-anchored, escape regex specials.
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

function hasAnyWord(haystack: string, words: string[]): boolean {
  return words.some((w) => hasWord(haystack, w));
}

function hasAnyPhrase(haystack: string, phrases: string[]): boolean {
  return phrases.some((p) => haystack.includes(p));
}

function computeRegexSignals(text: string): RegexSignals {
  const t = normalize(text);

  const safeguarding_hit =
    hasAnyPhrase(t, SAFEGUARDING_PHRASES) || hasAnyWord(t, SAFEGUARDING_WORDS);

  const same_day_hit = hasAnyPhrase(t, SAME_DAY_PHRASES);

  // Shout markers: explicit urgent words OR a bang-cluster ("!!!").
  const urgent_words = hasAnyWord(t, URGENT_WORDS) || /!{2,}/.test(t);

  const spam_hit = hasAnyPhrase(t, SPAM_PHRASES);

  const has_member_id = extractMemberId(text) !== null;
  const has_dob = extractDobOrAge(text) !== null;
  const has_payer = extractPayer(text) !== null;

  // fyi_only: an FYI/ack marker present AND no request verb / question mark.
  const fyi_only = hasAnyPhrase(t, FYI_PHRASES) && !hasAnyPhrase(t, REQUEST_VERBS);

  return {
    safeguarding_hit,
    same_day_hit,
    urgent_words,
    spam_hit,
    has_member_id,
    has_dob,
    has_payer,
    fyi_only,
  };
}

// ---------------------------------------------------------------------------
// Deterministic field extraction (used for fallback intake + has_* signals)
// ---------------------------------------------------------------------------

function extractMemberId(text: string): string | null {
  // Explicit "member ID: XXX".
  const labeled = text.match(/member\s*id[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (labeled && !isBlankToken(labeled[1])) return labeled[1].trim();
  // Generic letter-prefix member identifiers.
  const prefixed = text.match(/\b([A-Z]{2,5}-\d{3,})\b/);
  if (prefixed) return prefixed[1];
  return null;
}

function extractDobOrAge(text: string): string | null {
  // Any ISO-like date is treated as a DOB candidate, even when unrelated.
  const dob = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dob) return dob[1];
  // DOB-labelled slash date.
  const dobSlash = text.match(/\bdob[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (dobSlash) return dobSlash[1];
  // Age: "he is 6", "is 6", "tiene 5 anos", "my 4-year-old".
  const ageYr = text.match(/\b(\d{1,2})\s*[- ]?\s*(?:year|yr)s?\s*[- ]?\s*old\b/i);
  if (ageYr) return `${ageYr[1]} years old`;
  const ageEs = text.match(/\btiene\s+(\d{1,2})\s*a[nñ]os?\b/i);
  if (ageEs) return `${ageEs[1]} years old`;
  const ageIs = text.match(/\b(?:he|she|is|es)\s+(?:is\s+)?(\d{1,2})\b/i);
  if (ageIs && Number(ageIs[1]) <= 21) return `${ageIs[1]} years old`;
  return null;
}

function extractPayer(text: string): string | null {
  const payers: Array<{ re: RegExp; name: string }> = [
    { re: /\bdemoclear\b/i, name: "DemoClear" },
    { re: /\bdemoaway\b/i, name: "DemoAway" },
    { re: /\bdemostale\b/i, name: "DemoStale" },
    { re: /\bdemounknown\b/i, name: "DemoUnknown" },
  ];
  for (const p of payers) {
    if (p.re.test(text)) return p.name;
  }
  // Generic "Insurance: <X>" if not blank.
  const labeled = text.match(/insurance[:\s]+([A-Za-z][A-Za-z ]{2,30})/i);
  if (labeled && !isBlankToken(labeled[1])) return labeled[1].trim();
  return null;
}

function extractPhoneOrEmail(text: string): string | null {
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const phone = text.match(/\b\d{3}[-.\s]?\d{3,4}[-.\s]?\d{0,4}\b/);
  const parts: string[] = [];
  if (phone) parts.push(phone[0].trim());
  if (email) parts.push(email[0].trim());
  return parts.length ? parts.join(", ") : null;
}

function extractChildName(text: string): string | null {
  // Labelled, relationship-adjacent, age-adjacent, or referral-adjacent names.
  const labeled = text.match(/\b[Cc]hild[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (labeled && !isBlankToken(labeled[1])) return labeled[1].trim();
  const son = text.match(/\b(?:[Ss]on|[Dd]aughter|[Cc]hild|hij[ao])\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (son) return son[1].trim();
  const ageDescribed = text.match(/\b(?:my\s+)?\d{1,2}\s*[- ]?\s*(?:[Yy]ear|[Yy]r)s?\s*[- ]?\s*[Oo]ld\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (ageDescribed) return ageDescribed[1].trim();
  const forName = text.match(/\b(?:[Rr]eferral for|[Ee]val(?:uation)? for|for)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/);
  if (forName) return forName[1].trim();
  const beforeDob = text.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b[\s\S]{0,180}\b(?:DOB|dob)\b/);
  if (beforeDob) return beforeDob[1].trim();
  return null;
}

function extractParentContact(text: string): string | null {
  // Guardian label plus the first phone/email-like text.
  const labeled = text.match(/\b(?:parent|guardian|parent\/guardian)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const contact = extractPhoneOrEmail(text);
  if (labeled && !isBlankToken(labeled[1])) {
    return contact ? `${labeled[1].trim()}, ${contact}` : labeled[1].trim();
  }
  return contact;
}

function extractDisciplines(text: string): Discipline[] | null {
  const t = normalize(text);
  const found = new Set<Discipline>();
  // Prefer explicit "Discipline requested: SLP".
  const labeled = t.match(/discipline\s*(?:requested)?[:\s]+(slp|ot|pt)/i);
  if (labeled) {
    found.add(labeled[1].toUpperCase() as Discipline);
  }
  for (const { d, cues } of DISCIPLINE_CUES) {
    if (cues.some((c) => (c.length <= 3 ? hasWord(t, c) : t.includes(c)))) {
      found.add(d);
    }
  }
  const arr = [...found];
  return arr.length ? arr : null; // NEVER [] — null when empty.
}

function extractConcern(text: string): string | null {
  const labeled = text.match(/\b(?:concern|diagnosis|diagnosis\/concern)[:\s]+([^.\n]{3,120})/i);
  if (labeled && !isBlankToken(labeled[1])) return labeled[1].trim();
  return null;
}

function isBlankToken(s: string | null | undefined): boolean {
  if (!s) return true;
  const v = s.trim().toLowerCase();
  return v === "" || v === "[blank]" || v === "blank" || v === "n/a" || v === "tbd";
}

function fallbackExtractedIntake(item: InboxItem): ExtractedIntake {
  const text = `${item.subject} ${item.body}`;
  return {
    child_name: extractChildName(text),
    dob_or_age: extractDobOrAge(text),
    parent_contact: extractParentContact(text),
    discipline: extractDisciplines(text),
    diagnosis_or_concern: extractConcern(text),
    payer: extractPayer(text),
    member_id: extractMemberId(text),
  };
}

// ---------------------------------------------------------------------------
// Keyless fallback PerceptionSignals
// ---------------------------------------------------------------------------

function ruleBasedClassification(
  item: InboxItem,
  regex: RegexSignals,
  intake: ExtractedIntake,
): Classification {
  const t = normalize(`${item.subject} ${item.body}`);

  if (regex.safeguarding_hit) return "safeguarding";
  if (regex.spam_hit) return "spam";

  // Blank required referral fields on a fax referral -> missing_paperwork.
  const isReferral =
    item.channel === "fax_referral" || /\breferral\b/.test(t) || /\brefer\b/.test(t);
  const missingRequired =
    !intake.dob_or_age || !intake.payer || !intake.parent_contact || !intake.child_name;
  if (isReferral && missingRequired) return "missing_paperwork";

  // Same-day reschedule/cancel -> scheduling.
  if (regex.same_day_hit && /\b(reschedule|cancel|appointment|appt)\b/.test(t)) {
    return "scheduling";
  }

  // Clinical/developmental advice question (no booking) -> clinical_question.
  if (
    (t.includes("?") || /\b(is it normal|should i|should we|advice|worried)\b/.test(t)) &&
    !isReferral &&
    !/\b(reschedule|cancel)\b/.test(t)
  ) {
    return "clinical_question";
  }

  // Clean intake/eval request -> new_referral.
  if (isReferral || /\b(eval|evaluation|evaluacion|intake)\b/.test(t)) {
    return "new_referral";
  }

  return "other";
}

function fallbackSignals(item: InboxItem, regex: RegexSignals): PerceptionSignals {
  const intake = fallbackExtractedIntake(item);

  // Lexical hit is deliberately a priority backstop, not proof of harm.
  let safety_severity: SafetySeverity = "none";
  let safety_is_caregiving = false;
  let safety_reason = "No safety concern detected by deterministic lexicon.";
  if (regex.safeguarding_hit) {
    safety_severity = "clear";
    safety_is_caregiving = true;
    safety_reason =
      "Caregiving-harm lexicon matched in the message; treat as a safeguarding disclosure.";
  }

  // Time sensitivity: same_day regex => same_day.
  const time_sensitivity: TimeSensitivity = regex.same_day_hit ? "same_day" : "none";

  // requires_action: false only when fyi_only fires; otherwise true.
  const requires_action = !regex.fyi_only;

  const classification = ruleBasedClassification(item, regex, intake);

  return {
    extracted_intake: intake,
    classification,
    safety_severity,
    safety_reason,
    safety_is_caregiving,
    time_sensitivity,
    requires_action,
  };
}

// ---------------------------------------------------------------------------
// LLM cascade
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are an intake-triage perception layer for a pediatric therapy clinic (SLP/OT/PT).",
  "Your ONLY job is to (1) extract structured intake fields, (2) PROPOSE a classification, and",
  "(3) FLAG safety, time-sensitivity, and whether the message requires action.",
  "You DO NOT decide final urgency (P0/P1/P2/P3) and you DO NOT choose any actions or tools —",
  "deterministic downstream code owns those decisions. You are advisory only.",
  "",
  "SAFETY BAR IS DELIBERATELY LOW. If ANY part of the message discloses, suggests, or hints at",
  "harm, abuse, neglect, or unsafe caregiving toward the child (e.g. a caregiver being rough,",
  "hitting, leaving the child alone, the child scared/unsafe at home), set safety_severity to at",
  "least \"possible\" and set safety_is_caregiving to true. Use \"clear\" when the disclosure is",
  "explicit. A vague non-caregiving medical worry is NOT caregiving (safety_is_caregiving=false).",
  "",
  "extracted_intake fields are null when absent. discipline is an array of {SLP,OT,PT} or null —",
  "never an empty array. classification_confidence is 0..1 reflecting how sure you are.",
].join("\n");

// JSON schema mirroring PerceptionSignals (+ confidence/ambiguity for escalation gating).
const TRIAGE_TOOL = {
  name: TRIAGE_TOOL_NAME,
  description:
    "Emit structured perception signals for one inbox item. Advisory only — never decides urgency or actions.",
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      extracted_intake: {
        type: "object",
        additionalProperties: false,
        properties: {
          child_name: { type: ["string", "null"] },
          dob_or_age: { type: ["string", "null"] },
          parent_contact: { type: ["string", "null"] },
          discipline: {
            type: ["array", "null"],
            items: { type: "string", enum: ["SLP", "OT", "PT"] },
          },
          diagnosis_or_concern: { type: ["string", "null"] },
          payer: { type: ["string", "null"] },
          member_id: { type: ["string", "null"] },
        },
        required: [
          "child_name",
          "dob_or_age",
          "parent_contact",
          "discipline",
          "diagnosis_or_concern",
          "payer",
          "member_id",
        ],
      },
      classification: {
        type: "string",
        enum: [
          "new_referral",
          "existing_patient_request",
          "scheduling",
          "clinical_question",
          "billing_question",
          "missing_paperwork",
          "provider_followup",
          "complaint",
          "safeguarding",
          "spam",
          "other",
        ],
      },
      classification_confidence: { type: "number", minimum: 0, maximum: 1 },
      safety_severity: { type: "string", enum: ["none", "possible", "clear"] },
      safety_reason: { type: "string" },
      safety_is_caregiving: { type: "boolean" },
      time_sensitivity: { type: "string", enum: ["none", "same_day", "urgent"] },
      requires_action: { type: "boolean" },
      ambiguity_flags: { type: "array", items: { type: "string" } },
    },
    required: [
      "extracted_intake",
      "classification",
      "classification_confidence",
      "safety_severity",
      "safety_reason",
      "safety_is_caregiving",
      "time_sensitivity",
      "requires_action",
      "ambiguity_flags",
    ],
  },
};

const validModelInput = new Ajv({ strict: true, allErrors: true }).compile<RawLlmSignals>(TRIAGE_TOOL.input_schema);

// Raw shape returned by the model's tool_use input.
interface RawLlmSignals {
  extracted_intake: Partial<ExtractedIntake>;
  classification: Classification;
  classification_confidence: number;
  safety_severity: SafetySeverity;
  safety_reason: string;
  safety_is_caregiving: boolean;
  time_sensitivity: TimeSensitivity;
  requires_action: boolean;
  ambiguity_flags: string[];
}

const VALID_DISCIPLINES: Discipline[] = ["SLP", "OT", "PT"];

function coerceDiscipline(value: unknown): Discipline[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is Discipline =>
    VALID_DISCIPLINES.includes(v as Discipline),
  );
  return out.length ? out : null; // NEVER [] — null when empty.
}

function coerceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length ? v : null;
}

// Normalize a raw model tool input into a valid PerceptionSignals (defensive against partials).
function normalizeRawSignals(raw: RawLlmSignals): PerceptionSignals {
  const ei = raw.extracted_intake ?? {};
  const extracted_intake: ExtractedIntake = {
    child_name: coerceString(ei.child_name),
    dob_or_age: coerceString(ei.dob_or_age),
    parent_contact: coerceString(ei.parent_contact),
    discipline: coerceDiscipline(ei.discipline),
    diagnosis_or_concern: coerceString(ei.diagnosis_or_concern),
    payer: coerceString(ei.payer),
    member_id: coerceString(ei.member_id),
  };

  const severity: SafetySeverity = (["none", "possible", "clear"] as const).includes(
    raw.safety_severity,
  )
    ? raw.safety_severity
    : "none";
  const time: TimeSensitivity = (["none", "same_day", "urgent"] as const).includes(
    raw.time_sensitivity,
  )
    ? raw.time_sensitivity
    : "none";

  return {
    extracted_intake,
    classification: raw.classification,
    safety_severity: severity,
    safety_reason:
      coerceString(raw.safety_reason) ??
      (severity === "none" ? "No safety concern flagged." : "Safety concern flagged."),
    safety_is_caregiving: Boolean(raw.safety_is_caregiving),
    time_sensitivity: time,
    requires_action: raw.requires_action !== false, // default to true unless explicitly false.
  };
}

function preferDeterministicIntake(
  item: InboxItem,
  signals: PerceptionSignals,
): PerceptionSignals {
  const exact = fallbackExtractedIntake(item);
  return {
    ...signals,
    extracted_intake: {
      child_name: exact.child_name ?? signals.extracted_intake.child_name,
      dob_or_age: exact.dob_or_age ?? signals.extracted_intake.dob_or_age,
      parent_contact: exact.parent_contact ?? signals.extracted_intake.parent_contact,
      discipline: exact.discipline ?? signals.extracted_intake.discipline,
      diagnosis_or_concern:
        exact.diagnosis_or_concern ?? signals.extracted_intake.diagnosis_or_concern,
      payer: exact.payer ?? signals.extracted_intake.payer,
      member_id: exact.member_id ?? signals.extracted_intake.member_id,
    },
  };
}

// Extract the tool_use input from a messages.create response.
function readToolUseInput(message: Anthropic.Message): RawLlmSignals | null {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === TRIAGE_TOOL_NAME) {
      return validModelInput(block.input) ? block.input : null;
    }
  }
  return null;
}

async function runModel(
  client: Anthropic,
  model: string,
  item: InboxItem,
): Promise<RawLlmSignals | null> {
  const userText = [
    `Inbox item channel: ${item.channel}`,
    `Subject: ${item.subject}`,
    `Body: ${item.body}`,
    item.attachments?.length ? `Attachments: ${item.attachments.join(", ")}` : "",
    "",
    `Call ${TRIAGE_TOOL_NAME} with your perception signals for this item.`,
  ]
    .filter(Boolean)
    .join("\n");

  // Each call self-times-out, so a slow tier can't starve the cascade or hang the batch.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const message = await client.messages.create(
      {
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [TRIAGE_TOOL],
        tool_choice: { type: "tool", name: TRIAGE_TOOL_NAME },
        messages: [{ role: "user", content: userText }],
      },
      { signal: controller.signal },
    );
    return readToolUseInput(message);
  } catch {
    // Timeout / network error / anything else: this tier produced no usable result.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Decide whether the strong tier must review the fast result.
// Trigger when high-stakes/uncertain: any safety signal, low/ambiguous classification
// confidence, OR conflicting regex-vs-llm safety signals.
function shouldEscalateToStrong(
  raw: RawLlmSignals,
  regex: RegexSignals,
): boolean {
  const safetyFlagged = raw.safety_severity !== "none";
  const lowConfidence =
    typeof raw.classification_confidence !== "number" ||
    raw.classification_confidence < 0.75;
  const ambiguous = Array.isArray(raw.ambiguity_flags) && raw.ambiguity_flags.length > 0;
  // Conflict: regex caught safeguarding but model said none, or model flags safety but regex
  // is silent (either direction is a high-stakes disagreement worth a second opinion).
  const conflict =
    (regex.safeguarding_hit && raw.safety_severity === "none") ||
    (!regex.safeguarding_hit && raw.safety_severity !== "none" && raw.safety_is_caregiving);

  return safetyFlagged || lowConfidence || ambiguous || conflict;
}

// Run the fast tier, then strong tier if escalation criteria fire. Returns the chosen raw
// signals plus the model_path label. Each model call has its own abort timer.
async function runCascade(
  client: Anthropic,
  fastModel: string,
  strongModel: string,
  item: InboxItem,
  regex: RegexSignals,
): Promise<{ raw: RawLlmSignals; model_path: string } | null> {
  const fast = await runModel(client, fastModel, item);
  if (!fast) return null;

  if (shouldEscalateToStrong(fast, regex)) {
    const strong = await runModel(client, strongModel, item);
    if (strong) {
      return { raw: strong, model_path: "haiku->sonnet" };
    }
    // Strong tier produced nothing usable — keep the fast result, note the attempt.
    return { raw: fast, model_path: "haiku->sonnet(fast-kept)" };
  }

  return { raw: fast, model_path: "haiku" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Perceive one inbox item -> SignalBundle.
 *
 * Regex layer always runs. Explicit opt-in plus ANTHROPIC_API_KEY enables the fast model (escalating to the
 * strong model on high-stakes/uncertain results); on any timeout/error/missing key, we fall back
 * to deterministic regex+heuristic signals. Never throws; always returns a fully-populated bundle.
 */
export const perceive: Perceive = async (item: InboxItem): Promise<SignalBundle> => {
  const apiKey = process.env.INTAKEGATE_ALLOW_MODEL === "1" ? process.env.ANTHROPIC_API_KEY : undefined;
  const fastModel = process.env.ANTHROPIC_FAST_MODEL || DEFAULT_FAST_MODEL;
  const strongModel = process.env.ANTHROPIC_STRONG_MODEL || DEFAULT_STRONG_MODEL;
  const client = apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : null;
  return perceiveWithClient(item, client, fastModel, strongModel);
};

// Transport injection allows the complete cascade to be tested without network requests.
export async function perceiveWithClient(
  item: InboxItem, client: Anthropic | null,
  fastModel = DEFAULT_FAST_MODEL, strongModel = DEFAULT_STRONG_MODEL,
): Promise<SignalBundle> {
  const text = `${item.subject ?? ""} ${item.body ?? ""}`;
  const regex = computeRegexSignals(text);

  if (client) {
    try {
      const result = await runCascade(client, fastModel, strongModel, item, regex);
      if (result) {
        return {
          item_id: item.id,
          regex,
          llm: preferDeterministicIntake(item, normalizeRawSignals(result.raw)),
          source: "llm",
          model_path: result.model_path,
        };
      }
      // No usable tool input — fall through to fallback.
    } catch {
      // Timeout, network error, malformed output, or anything else — fall back per item.
    }
  }

  // KEYLESS FALLBACK (no key / timeout / error / unusable output).
  return {
    item_id: item.id,
    regex,
    llm: fallbackSignals(item, regex),
    source: "fallback",
    model_path: "fallback",
  };
}
