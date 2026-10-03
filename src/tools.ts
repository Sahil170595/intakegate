import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";
import type { Assignee, Discipline, PolicyTopic, Resources, Slot, ToolCall, ToolResult, TraceEntry } from "./types.js";

export interface SessionOptions {
  id?: () => string; now?: () => string; itemId?: string;
  beforeCall?: (name: string) => void;
}
interface Session { resources: Resources; trace: TraceEntry[]; options: SessionOptions }
const sessions = new AsyncLocalStorage<Session>();
const items = new AsyncLocalStorage<string>();
function session(): Session {
  const s = sessions.getStore();
  if (!s) throw new Error("Tools require withToolSession; use runLocalBatch for validated input");
  return s;
}
export function withToolSession<T>(resources: Resources, fn: () => Promise<T>, options: SessionOptions = {}): Promise<T> {
  return sessions.run({ resources: structuredClone(resources), trace: [], options }, () =>
    items.run(options.itemId ?? "batch", fn));
}
export function withItemContext<T>(id: string, fn: () => Promise<T>): Promise<T> { return items.run(id, fn); }
export function getTrace(): TraceEntry[] { return structuredClone(session().trace); }
export function getToolCallsForItem(id: string): ToolCall[] {
  return getTrace().filter((t) => t.item_id === id).map(({ call_id, name, args, result_summary }) =>
    ({ call_id, name, args, result_summary }));
}
export function sessionNow(): string { return session().options.now?.() ?? new Date().toISOString(); }
function identifier(): string { return session().options.id?.() ?? ulid(); }
async function record<T>(name: string, args: Record<string, unknown>, make: () => T): Promise<ToolResult<T>> {
  const s = session(); s.options.beforeCall?.(name);
  const data = make(); const call_id = identifier();
  const result_summary = `[synthetic-local] ${JSON.stringify(data)}`;
  const call = { call_id, name, args: structuredClone(args), result_summary };
  if (s.trace.some((t) => t.call_id === call_id)) throw new Error("Duplicate call ID");
  s.trace.push({ ...call, item_id: items.getStore() ?? "batch", timestamp: sessionNow() });
  return { ...structuredClone(call), data: structuredClone(data) };
}
export async function search_patient(args: { name: string; dob?: string }) {
  return record("search_patient", args, () => session().resources.patients.filter((p) =>
    p.status === "active" && p.name.toLowerCase() === args.name.trim().toLowerCase() && (!args.dob || p.dob === args.dob)));
}
export async function verify_insurance(args: { payer: string; member_id?: string }) {
  return record("verify_insurance", args, () => {
    const match = session().resources.coverage.find((c) => c.payer.toLowerCase() === args.payer.toLowerCase() && c.member_id === args.member_id);
    return { status: match?.status ?? "unknown", auth_required: match?.auth_required ?? false,
      evidence: "Synthetic exact payer/member lookup; not real benefit verification" };
  });
}
export async function lookup_policy(args: { topic: PolicyTopic }) {
  return record("lookup_policy", args, () => ({ topic: args.topic, text: session().resources.policies[args.topic] }));
}
export async function find_slots(args: { discipline?: Discipline; language?: string }) {
  return record("find_slots", args, (): Slot[] => session().resources.providers
    .filter((p) => p.caseload_status !== "full" && (!args.discipline || p.discipline === args.discipline) &&
      (!args.language || p.languages.includes(args.language)))
    .flatMap((p) => p.next_available_slots.map((slot) => ({ ...slot, provider_id: p.provider_id,
      provider_name: p.name, discipline: p.discipline, languages: p.languages })))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.slot_id.localeCompare(b.slot_id)).slice(0, 5));
}
export async function create_task(args: { assignee: Assignee; title: string; due: string; notes: string }) {
  return record("create_task", args, () => ({ task_id: identifier(), status: "local-draft", externally_persisted: false }));
}
export async function draft_message(args: { recipient: string; channel: "email" | "portal" | "phone"; body: string; language: string }) {
  return record("draft_message", args, () => ({ draft_id: identifier(), status: "unsent", sent: false }));
}
export async function escalate(args: { item_id: string; reason: string; severity: "P0" | "P1" }) {
  return record("escalate", args, () => ({ escalation_id: identifier(), status: "local-request", notified: false }));
}
export async function hold_slot(args: { slot_id: string }) {
  return record("hold_slot", args, () => ({ request_id: identifier(), slot_id: args.slot_id, reserved: false }));
}
