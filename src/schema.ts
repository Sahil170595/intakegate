// Independent public contracts. Nothing here grants authority to take external actions.
export const classifications = ["new_referral", "existing_patient_request", "scheduling", "clinical_question",
  "billing_question", "missing_paperwork", "provider_followup", "complaint", "safeguarding", "spam", "other"];
export const topics = ["service_lines", "insurance", "safeguarding", "clinical_advice", "scheduling", "cancellation", "language_access"];
const text = { type: "string", maxLength: 12000 };
const nonempty = { ...text, minLength: 1 };
const nullable = { anyOf: [text, { type: "null" }] };
const timestamp = { type: "string", format: "date-time" };
const strings = { type: "array", items: text, maxItems: 100 };
const enumeration = (values: string[]) => ({ type: "string", enum: values });
const array = (items: object, maxItems = 1000) => ({ type: "array", items, maxItems });
export const object = (properties: Record<string, object>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const discipline = enumeration(["SLP", "OT", "PT"]);
export const intakeSchema = object({ child_name: nullable, dob_or_age: nullable, parent_contact: nullable,
  discipline: { anyOf: [{ ...array(discipline, 3), minItems: 1, uniqueItems: true }, { type: "null" }] },
  diagnosis_or_concern: nullable, payer: nullable, member_id: nullable });
export const toolSchema = object({ call_id: nonempty, name: nonempty,
  args: { type: "object", additionalProperties: true }, result_summary: nonempty });
const itemProperties = {
  item_id: nonempty, classification: enumeration(classifications), urgency: enumeration(["P0", "P1", "P2", "P3"]),
  requires_human_review: { const: true }, extracted_intake: intakeSchema, missing_info: strings,
  tools_called: array(toolSchema), recommended_next_action: nonempty, draft_reply: nullable,
  task_ids: strings, escalation: { anyOf: [object({ reason: nonempty, severity: enumeration(["P0", "P1"]) }), { type: "null" }] },
  decision_rationale: nonempty,
};
const count = { type: "integer", minimum: 0, maximum: 100 };
export const outputSchema = { $schema: "http://json-schema.org/draft-07/schema#", ...object({
  schema_version: { const: 1 }, execution_mode: { const: "synthetic-local" }, generated_at: timestamp,
  summary: object({ total_items: count, p0_count: count, p1_count: count, requires_human_review_count: count }),
  items: array(object(itemProperties), 100),
}) };
export const traceSchema = array(object({ ...toolSchema.properties, item_id: nonempty, timestamp }));
export const inboxSchema = array(object({ id: nonempty,
  channel: enumeration(["fax_referral", "voicemail_transcript", "portal_message", "email"]),
  received_at: timestamp, sender: nonempty, subject: text, body: text, attachments: strings }), 100);
export const resourcesSchema = object({
  patients: array(object({ patient_id: nonempty, name: nonempty, dob: { type: "string", format: "date" },
    guardian_name: nonempty, status: enumeration(["active", "inactive"]) }), 100),
  providers: array(object({ provider_id: nonempty, name: nonempty, discipline,
    languages: { ...strings, minItems: 1, uniqueItems: true }, age_range: text,
    caseload_status: enumeration(["accepting", "limited", "full"]),
    next_available_slots: array(object({ slot_id: nonempty, start: timestamp, appointment_type: nonempty }), 100) }), 100),
  coverage: array(object({ payer: nonempty, member_id: nonempty,
    status: enumeration(["in_network", "out_of_network", "expired", "unknown"]), auth_required: { type: "boolean" } }), 100),
  policies: object(Object.fromEntries(topics.map((topic) => [topic, nonempty]))),
});
