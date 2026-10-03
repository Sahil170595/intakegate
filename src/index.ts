import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { runLocalBatch } from "./runtime.js";
import { validateBatch, validateInbox } from "./validate.js";
import { outputSchema } from "./schema.js";

function readJson(path: string): unknown {
  if (statSync(path).size > 1_000_000) throw new Error("Input file exceeds 1 MB limit");
  return JSON.parse(readFileSync(path, "utf8"));
}
function args(argv: string[]) {
  const flags = new Map<string, string>(); let allowModel = false;
  for (let n = 0; n < argv.length; n++) {
    if (argv[n] === "--allow-model") { allowModel = true; continue; }
    if (!["--input", "--resources", "--output", "--trace"].includes(argv[n]) || !argv[n + 1] || argv[n + 1].startsWith("--")) {
      throw new Error(`Invalid argument: ${argv[n]}`);
    }
    if (flags.has(argv[n])) throw new Error(`Duplicate argument: ${argv[n]}`);
    flags.set(argv[n], argv[++n]);
  }
  return { allowModel, input: flags.get("--input") ?? "fixtures/inbox.synthetic.json",
    resources: flags.get("--resources") ?? "fixtures/resources.synthetic.json",
    output: flags.get("--output") ?? ".intakegate/output.json", trace: flags.get("--trace") ?? ".intakegate/trace.json" };
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log("Intakegate: triage [--input file --resources file --output file --trace file] [--allow-model]\nvalidate [--input file --output file --trace file]\nschema\nDefault: synthetic-local, offline; all external action adapters are stubs."); return;
  }
  const command = ["triage", "validate", "schema"].includes(argv[0]) ? argv.shift()! : "triage";
  if (command === "schema") { if (argv.length) throw new Error("schema takes no arguments"); console.log(JSON.stringify(outputSchema, null, 2)); return; }
  const config = args(argv);
  const input = readJson(config.input); validateInbox(input);
  if (command === "validate") {
    if (config.allowModel) throw new Error("Validation cannot enable models");
    validateBatch(readJson(config.output), input, readJson(config.trace)); console.log("Valid synthetic-local output and trace"); return;
  }
  const paths = [config.input, config.resources, config.output, config.trace].map((p) => {
    const full = resolve(p); return process.platform === "win32" ? full.toLowerCase() : full;
  });
  if (new Set(paths).size !== paths.length) throw new Error("Input, resources, output and trace must use distinct paths");
  if ([config.output, config.trace].some((p) => existsSync(p))) throw new Error("Choose new output and trace paths; existing files are not overwritten");
  process.env.INTAKEGATE_ALLOW_MODEL = config.allowModel ? "1" : "0";
  if (config.allowModel && !process.env.ANTHROPIC_API_KEY) throw new Error("--allow-model requires an explicitly exported API key");
  const { output, trace } = await runLocalBatch(input, readJson(config.resources));
  for (const [path, value] of [[config.output, output], [config.trace, trace]] as const) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify({ execution_mode: output.execution_mode, ...output.summary }));
  console.log("Local records and unsent drafts only. No appointments, messages or notifications delivered.");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
