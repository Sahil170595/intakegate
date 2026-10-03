import { runAgent } from "./agent.js";
import { getTrace, sessionNow, withToolSession, type SessionOptions } from "./tools.js";
import { validateInbox, validateResources, validateBatch } from "./validate.js";
import type { BatchOutput } from "./types.js";

export async function runLocalBatch(input: unknown, resources: unknown, options: SessionOptions = {}) {
  validateInbox(input); validateResources(resources);
  return withToolSession(resources, async () => {
    const items = await runAgent(input);
    const output: BatchOutput = { schema_version: 1, execution_mode: "synthetic-local", generated_at: sessionNow(),
      summary: { total_items: items.length, p0_count: items.filter((i) => i.urgency === "P0").length,
        p1_count: items.filter((i) => i.urgency === "P1").length,
        requires_human_review_count: items.filter((i) => i.requires_human_review).length }, items };
    const trace = getTrace(); validateBatch(output, input, trace);
    return { output, trace };
  }, options);
}
