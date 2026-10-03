import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { runLocalBatch } from "../src/runtime.js";
import { perceive, perceiveWithClient } from "../src/triage/perceive.js";
import { scoreUrgency } from "../src/triage/score.js";
import { orchestrate } from "../src/triage/orchestrate.js";
import { assembleItemOutput } from "../src/triage/assemble.js";
import { find_slots, hold_slot, getTrace, withToolSession } from "../src/tools.js";
import { validateInbox, validateResources, validateBatch } from "../src/validate.js";
import type { InboxItem, Resources, BatchOutput } from "../src/types.js";
import type { SignalBundle } from "../src/triage/types.js";

const inbox = JSON.parse(readFileSync(new URL("../fixtures/inbox.synthetic.json", import.meta.url), "utf8")) as InboxItem[];
const resources = JSON.parse(readFileSync(new URL("../fixtures/resources.synthetic.json", import.meta.url), "utf8")) as Resources;
process.env.INTAKEGATE_ALLOW_MODEL = "0";
globalThis.fetch = async () => { throw new Error("Network disabled in offline tests"); };
const entry = (id: string) => structuredClone(inbox.find((item) => item.id === id)!);
const options = () => {
  let n = 0;
  return { id: () => `test-${++n}`, now: () => "2030-01-01T09:00:00.000Z" };
};
function bundle(): SignalBundle {
  return { item_id: "analytical", source: "fallback", model_path: "fallback",
    regex: { safeguarding_hit: false, same_day_hit: false, urgent_words: false, spam_hit: false,
      has_member_id: false, has_dob: false, has_payer: false, fyi_only: false },
    llm: { extracted_intake: { child_name: null, dob_or_age: null, parent_contact: null,
      discipline: null, diagnosis_or_concern: null, payer: null, member_id: null },
      classification: "other", safety_severity: "none", safety_reason: "", safety_is_caregiving: false,
      time_sensitivity: "none", requires_action: true } };
}
test("input fixtures and empty cohort are valid", async () => {
  validateInbox(inbox); validateResources(resources);
  const { output, trace } = await runLocalBatch([], resources, options());
  assert.equal(output.summary.total_items, 0); validateBatch(output, [], trace);
});
test("analytical thresholds and zero-weight shouting", () => {
  for (const day of [false, true]) for (const spam of [false, true]) for (const action of [false, true]) {
    const b = bundle(); b.regex.same_day_hit = day; b.regex.spam_hit = spam; b.llm.requires_action = action;
    const value = (day && action ? 2 : 0) - (spam ? 2 : 0);
    const expected = value >= 2 ? "P1" : value <= -2 ? "P3" : "P2";
    assert.equal(scoreUrgency(b).urgency, expected);
    b.regex.urgent_words = true; assert.equal(scoreUrgency(b).urgency, expected);
  }
  const b = bundle(); b.llm.classification = "complaint"; b.llm.time_sensitivity = "urgent";
  assert.equal(scoreUrgency(b).urgency, "P2");
  b.regex.same_day_hit = true; assert.equal(scoreUrgency(b).urgency, "P1");
  const fyi = bundle(); fyi.regex.fyi_only = true; fyi.llm.requires_action = false;
  assert.equal(scoreUrgency(fyi).urgency, "P2");
});
test("categorical safety dominates negative weights", () => {
  const b = bundle(); b.regex.spam_hit = true; b.regex.safeguarding_hit = true;
  assert.equal(scoreUrgency(b).urgency, "P0"); assert.equal(scoreUrgency(b).classification, "safeguarding");
  b.regex.safeguarding_hit = false; b.llm.safety_severity = "possible"; b.llm.safety_is_caregiving = true;
  assert.equal(scoreUrgency(b).urgency, "P0"); b.llm.safety_is_caregiving = false;
  assert.equal(scoreUrgency(b).urgency, "P1"); assert.equal(scoreUrgency(b).escalation, null);
});
test("missing child identity is reported", async () => {
  const { output } = await runLocalBatch([entry("missing")], resources, options());
  assert.equal(output.items[0].classification, "missing_paperwork");
  assert.ok(output.items[0].missing_info.includes("child name"));
});
test("P0 records escalation, policy, task and unsent draft; no booking", async () => {
  const { output, trace } = await runLocalBatch([entry("safety")], resources, options());
  const i = output.items[0]; assert.equal(i.urgency, "P0");
  assert.deepEqual(i.tools_called.map((c) => c.name), ["escalate", "lookup_policy", "create_task", "draft_message"]);
  assert.equal(i.tools_called[2].args.assignee, "clinical_lead");
  assert.equal(i.tools_called[2].args.due, entry("safety").received_at);
  assert.match(i.decision_rationale, /local/);
  assert.ok(trace.every((t) => t.result_summary.includes("synthetic-local")));
});
test("same-day request proposes staff review without rescheduling", async () => {
  const { output } = await runLocalBatch([entry("schedule")], resources, options());
  const i = output.items[0]; assert.equal(i.urgency, "P1"); assert.equal(i.classification, "scheduling");
  assert.equal(i.tools_called.find((c) => c.name === "create_task")!.args.due, "2030-01-01");
  assert.ok(!i.tools_called.some((c) => c.name === "hold_slot"));
});
for (const id of ["away", "stale"]) test(`${id} coverage gates slot search`, async () => {
  const { output } = await runLocalBatch([entry(id)], resources, options());
  const calls = output.items[0].tools_called;
  assert.equal(calls.find((c) => c.name === "create_task")!.args.assignee, "billing");
  assert.ok(!calls.some((c) => ["find_slots", "hold_slot"].includes(c.name)));
});
test("unknown coverage still surfaces unbooked options: known limitation", async () => {
  const { output } = await runLocalBatch([entry("unknown")], resources, options());
  assert.ok(output.items[0].tools_called.some((c) => c.name === "find_slots"));
  assert.ok(!output.items[0].tools_called.some((c) => c.name === "hold_slot"));
});
test("Spanish/capacity filtering and chronological sorting; hold is only a draft", async () => {
  await withToolSession(resources, async () => {
    const slots = (await find_slots({ discipline: "SLP", language: "es" })).data;
    assert.deepEqual(slots.map((s) => s.slot_id), ["slot-early", "slot-late"]);
    const before = JSON.stringify(resources);
    assert.equal((await hold_slot({ slot_id: "slot-early" })).data.reserved, false);
    assert.equal(JSON.stringify(resources), before);
  }, options());
  const { output } = await runLocalBatch([entry("spanish")], resources, options());
  assert.equal(output.items[0].tools_called.find((c) => c.name === "find_slots")!.args.language, "es");
  assert.match(output.items[0].draft_reply!, /^Hola/);
});
test("full cohort, zero-tool spam, review flag and deterministic isolated replay", async () => {
  const a = await runLocalBatch(inbox, resources, options());
  const b = await runLocalBatch(inbox, resources, options()); assert.deepEqual(a, b);
  assert.ok(a.output.items.every((i) => i.requires_human_review));
  assert.equal(a.output.items.find((i) => i.item_id === "spam")!.tools_called.length, 0);
  validateBatch(a.output, inbox, a.trace);
  const [c, d] = await Promise.all([runLocalBatch([entry("safety")], resources, options()), runLocalBatch([entry("spam")], resources, options())]);
  assert.ok(c.trace.every((t) => t.item_id === "safety")); assert.deepEqual(d.trace, []);
});
test("adapter failure must not downgrade an already scored P0", async () => {
  const { output, trace } = await runLocalBatch([entry("safety")], resources, {
    ...options(), beforeCall: (name) => { if (name === "create_task") throw new Error("synthetic fault"); },
  });
  assert.equal(output.items[0].urgency, "P0"); assert.equal(output.items[0].classification, "safeguarding");
  assert.match(output.items[0].decision_rationale, /pipeline error/i);
  assert.equal(output.items[0].tools_called.length, 2); validateBatch(output, [entry("safety")], trace);
});
test("late adapter failure retains successful local task evidence", async () => {
  const { output, trace } = await runLocalBatch([entry("safety")], resources, {
    ...options(), beforeCall: (name) => { if (name === "draft_message") throw new Error("synthetic late fault"); },
  });
  assert.equal(output.items[0].urgency, "P0");
  assert.equal(output.items[0].task_ids.length, 1);
  assert.equal(output.items[0].draft_reply, null);
  validateBatch(output, [entry("safety")], trace);
});
test("empty patient lookup cannot produce a confirmed-match draft", async () => {
  await withToolSession(resources, async () => {
    const item = entry("clear"); const b = await perceive(item); b.llm.classification = "existing_patient_request";
    const o = await orchestrate(item, b, scoreUrgency(b));
    assert.doesNotMatch(o.draft_reply!, /We found/); assert.match(o.draft_reply!, /confirm.*record/i);
  }, { ...options(), itemId: "clear" });
});
test("assembly normalizes disciplines and preserves trace IDs", async () => {
  await withToolSession(resources, async () => {
    await find_slots({ discipline: "SLP" }); const b = bundle(); b.llm.extracted_intake.discipline = ["SLP", "SLP"];
    const result = { task_ids: [], draft_reply: null, missing_info: [], recommended_next_action: "Review", notes: [] };
    const item = { ...entry("clear"), id: "analytical" };
    const o = assembleItemOutput(item, b, scoreUrgency(b), result);
    assert.deepEqual(o.extracted_intake.discipline, ["SLP"]);
    assert.deepEqual(o.tools_called.map((c) => c.call_id), getTrace().map((c) => c.call_id));
    b.llm.extracted_intake.discipline = [];
    assert.equal(assembleItemOutput(item, b, scoreUrgency(b), result).extracted_intake.discipline, null);
  }, { ...options(), itemId: "analytical" });
});
test("negated safety and arbitrary ISO dates demonstrate lexical failure cases", async () => {
  const item = entry("clear"); item.subject = "Status"; item.body = "There is no abuse. Review on 2031-02-03.";
  const b = await perceive(item); assert.equal(scoreUrgency(b).urgency, "P0");
  assert.equal(b.llm.extracted_intake.dob_or_age, "2031-02-03");
});
test("ambient credentials alone do not trigger provider execution", async () => {
  const old = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "synthetic-test-only";
  try { assert.equal((await perceive(entry("clear"))).source, "fallback"); }
  finally { if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old; }
});
const raw = () => ({ ...bundle().llm, classification_confidence: 0.95, ambiguity_flags: [] as string[] });
function fake(responses: unknown[], calls: string[]): Anthropic {
  return { messages: { create: async (request: { model: string }) => {
    calls.push(request.model); const r = responses.shift(); if (r instanceof Error) throw r;
    return { content: [{ type: "tool_use", name: "emit_triage_signals", input: r }] };
  } } } as unknown as Anthropic;
}
test("cascade covers fast-only, uncertainty, ambiguity, conflict, and tier failures", async () => {
  const confident = raw(), uncertain = { ...raw(), classification_confidence: 0.4 };
  for (const [responses, path, count] of [
    [[confident], "haiku", 1], [[uncertain, confident], "haiku->sonnet", 2],
    [[uncertain, new Error("synthetic")], "haiku->sonnet(fast-kept)", 2],
    [[new Error("synthetic")], "fallback", 1],
    [[{ ...raw(), ambiguity_flags: ["uncertain"] }, confident], "haiku->sonnet", 2],
  ] as const) {
    const calls: string[] = []; const b = await perceiveWithClient(entry("clear"), fake([...responses], calls));
    assert.equal(b.model_path, path); assert.equal(calls.length, count);
  }
  const calls: string[] = []; const b = await perceiveWithClient(entry("safety"), fake([confident, confident], calls));
  assert.equal(calls.length, 2); assert.equal(scoreUrgency(b).urgency, "P0");
});
test("malformed model inputs fall back instead of coercing false into true", async () => {
  for (const invalid of [null, { ...raw(), classification: "invented" }, { ...raw(), safety_is_caregiving: "false" }, { ...raw(), classification_confidence: NaN }]) {
    assert.equal((await perceiveWithClient(entry("clear"), fake([invalid], []))).source, "fallback");
  }
});
test("input rejects duplicate IDs, dates, extra properties, channels, and excessive cohorts", () => {
  for (const invalid of [null, [entry("clear"), entry("clear")], [{ ...entry("clear"), received_at: "invalid" }],
    [{ ...entry("clear"), channel: "text" }], [{ ...entry("clear"), token: "extra" }],
    Array.from({ length: 101 }, (_, i) => ({ ...entry("clear"), id: String(i) }))]) assert.throws(() => validateInbox(invalid));
  assert.throws(() => validateResources({ ...resources, secret: "extra" }));
  const r = structuredClone(resources); r.providers[1].provider_id = r.providers[0].provider_id;
  assert.throws(() => validateResources(r));
});
test("validator rejects missing, mutated, extra or misattributed evidence and forged artifacts", async () => {
  const { output, trace } = await runLocalBatch([entry("safety")], resources, options()); const input = [entry("safety")];
  const mutate = (f: (o: BatchOutput) => void) => { const o = structuredClone(output); f(o); assert.throws(() => validateBatch(o, input, trace)); };
  mutate((o) => { o.items[0].tools_called.pop(); });
  mutate((o) => { o.items[0].tools_called[0].args.reason = "modified"; });
  mutate((o) => { o.items[0].tools_called.push({ ...o.items[0].tools_called[0], call_id: "invented" }); });
  mutate((o) => { o.summary.p0_count = 0; }); mutate((o) => { o.items[0].requires_human_review = false; });
  mutate((o) => { o.items[0].task_ids.push("invented"); }); mutate((o) => { o.items[0].draft_reply = "invented"; });
  assert.throws(() => validateBatch(output, input, [...trace, { ...trace[0], call_id: "extra" }]));
  assert.throws(() => validateBatch(output, input, [{ ...trace[0], item_id: "wrong" }, ...trace.slice(1)]));
});
test("CLI help/schema are usable; unknown arguments and overlapping paths fail before writes", () => {
  const prefix = ["node_modules/tsx/dist/cli.mjs", "src/index.ts"];
  const env = { ...process.env, TSX_DISABLE_CACHE: "1", INTAKEGATE_ALLOW_MODEL: "0" };
  assert.match(execFileSync(process.execPath, [...prefix, "--help"], { env, encoding: "utf8" }), /offline/);
  const schema = JSON.parse(execFileSync(process.execPath, [...prefix, "schema"], { env, encoding: "utf8" }));
  assert.equal(schema.properties.execution_mode.const, "synthetic-local");
  for (const args of [["--unknown"], ["--output", "fixtures/inbox.synthetic.json"]]) {
    const result = spawnSync(process.execPath, [...prefix, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid argument|distinct paths/);
  }
});
