import { Ajv, type ValidateFunction } from "ajv";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { inboxSchema, outputSchema, resourcesSchema, traceSchema } from "./schema.js";
import type { BatchOutput, InboxItem, Resources, TraceEntry } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: true });
createRequire(import.meta.url)("ajv-formats")(ajv);
const inputCheck = ajv.compile(inboxSchema), resourceCheck = ajv.compile(resourcesSchema);
const outputCheck = ajv.compile(outputSchema), traceCheck = ajv.compile(traceSchema);
export function assertSchema(check: ValidateFunction, value: unknown, label: string): void {
  if (!check(value)) throw new Error(`${label}: ${ajv.errorsText(check.errors, { separator: "; " })}`);
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
export function validateInbox(value: unknown): asserts value is InboxItem[] {
  assertSchema(inputCheck, value, "Inbox"); unique((value as InboxItem[]).map((i) => i.id), "inbox IDs");
}
export function validateResources(value: unknown): asserts value is Resources {
  assertSchema(resourceCheck, value, "Resources"); const r = value as Resources;
  unique(r.patients.map((p) => p.patient_id), "patient IDs"); unique(r.providers.map((p) => p.provider_id), "provider IDs");
  unique(r.providers.flatMap((p) => p.next_available_slots.map((s) => s.slot_id)), "slot IDs");
  unique(r.coverage.map((c) => JSON.stringify([c.payer.toLowerCase(), c.member_id])), "coverage records");
}
export function validateBatch(value: unknown, inbox: InboxItem[], traceValue: unknown): asserts value is BatchOutput {
  validateInbox(inbox); assertSchema(outputCheck, value, "Output"); assertSchema(traceCheck, traceValue, "Trace");
  const o = value as BatchOutput, trace = traceValue as TraceEntry[];
  unique(o.items.map((i) => i.item_id), "output IDs"); unique(trace.map((t) => t.call_id), "trace call IDs");
  if (!isDeepStrictEqual(o.items.map((i) => i.item_id), inbox.map((i) => i.id))) throw new Error("Output coverage/order differs from inbox");
  const summary = { total_items: o.items.length, p0_count: o.items.filter((i) => i.urgency === "P0").length,
    p1_count: o.items.filter((i) => i.urgency === "P1").length,
    requires_human_review_count: o.items.filter((i) => i.requires_human_review).length };
  if (!isDeepStrictEqual(o.summary, summary)) throw new Error("Summary counts differ from items");
  const ids = new Set(inbox.map((i) => i.id));
  if (trace.some((t) => !ids.has(t.item_id))) throw new Error("Trace contains unowned item IDs");
  for (const item of o.items) {
    const evidence = trace.filter((t) => t.item_id === item.item_id);
    const calls = evidence.map(({ call_id, name, args, result_summary }) => ({ call_id, name, args, result_summary }));
    if (!isDeepStrictEqual(item.tools_called, calls)) throw new Error(`Trace mismatch for ${item.item_id}`);
    const tasks = evidence.filter((t) => t.name === "create_task").map((t) => {
      if (!t.result_summary.startsWith("[synthetic-local] ")) throw new Error("Unknown trace result format");
      return (JSON.parse(t.result_summary.slice(18)) as { task_id: string }).task_id;
    });
    if (!isDeepStrictEqual(item.task_ids, tasks)) throw new Error("Task IDs differ from local task evidence");
    const drafts = evidence.filter((t) => t.name === "draft_message");
    if (drafts.length > 1 || (item.draft_reply !== null && item.draft_reply !== drafts[0]?.args.body)) throw new Error("Draft differs from evidence");
    if (item.draft_reply === null && drafts.length) throw new Error("Draft evidence omitted");
  }
}
