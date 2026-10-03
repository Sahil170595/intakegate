import { getToolCallsForItem, withItemContext } from "./tools.js";
import { assembleItemOutput } from "./triage/assemble.js";
import { orchestrate } from "./triage/orchestrate.js";
import { perceive } from "./triage/perceive.js";
import { scoreUrgency } from "./triage/score.js";
import type { ScoreResult } from "./triage/types.js";
import type { ExtractedIntake, InboxItem, ItemOutput } from "./types.js";

/**
 * Triage every inbox item through the hybrid pipeline:
 *   perceive (LLM cascade + regex + keyless fallback)
 *     -> scoreUrgency (deterministic, owns the final urgency/classification decision)
 *       -> orchestrate (records local synthetic tools inside the item's audit context)
 *         -> assembleItemOutput (schema-valid ItemOutput, trace-match-safe).
 */
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  // Serial item execution keeps the audit order easy to inspect.
  const outputs: ItemOutput[] = [];
  for (const item of inbox) {
    outputs.push(await triageItem(item));
  }
  return outputs;
}

async function triageItem(item: InboxItem): Promise<ItemOutput> {
  let knownScore: ScoreResult | undefined;
  try {
    const bundle = await perceive(item);
    const score = scoreUrgency(bundle);
    knownScore = score;
    const orchestration = await withItemContext(item.id, () =>
      orchestrate(item, bundle, score),
    );
    return assembleItemOutput(item, bundle, score, orchestration);
  } catch (error) {
    // Never drop an item - the validator requires exactly one output per input id.
    return safeFallbackOutput(item, error, knownScore);
  }
}

/**
 * Last-resort output if a single item's pipeline throws. Surfaces any tool calls already
 * recorded so the audit trace still matches. A known priority must not be downgraded.
 */
function safeFallbackOutput(item: InboxItem, error: unknown, knownScore?: ScoreResult): ItemOutput {
  const reason = error instanceof Error ? error.message : String(error);
  const calls = getToolCallsForItem(item.id);
  // A late failure must not erase local artifacts already present in captured evidence.
  const taskIds = calls.filter((call) => call.name === "create_task").map((call) =>
    (JSON.parse(call.result_summary.slice("[synthetic-local] ".length)) as { task_id: string }).task_id);
  const draftBody = calls.find((call) => call.name === "draft_message")?.args.body;
  return {
    item_id: item.id,
    classification: knownScore?.classification ?? "other",
    urgency: knownScore?.urgency ?? "P1",
    requires_human_review: true,
    extracted_intake: emptyIntake(),
    missing_info: ["triage pipeline error - needs manual review"],
    tools_called: calls,
    recommended_next_action:
      "Manual triage required: the automated pipeline errored on this item.",
    draft_reply: typeof draftBody === "string" ? draftBody : null,
    task_ids: taskIds,
    escalation: knownScore?.escalation ?? null,
    decision_rationale: `Pipeline error; ${knownScore ? `preserved scored ${knownScore.urgency}` : "unscored P1 manual review"}. No external action confirmed. Cause: ${reason}`,
  };
}

function emptyIntake(): ExtractedIntake {
  return {
    child_name: null,
    dob_or_age: null,
    parent_contact: null,
    discipline: null,
    diagnosis_or_concern: null,
    payer: null,
    member_id: null,
  };
}
