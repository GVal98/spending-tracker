/**
 * Smoke test against the live LLM (no DB, no Telegram): how well does the
 * model pick the right receipt item from a free-text correction?
 *
 * Usage: npm run smoke:item-edit
 * Needs OPENROUTER_API_KEY and OPENROUTER_MODEL in .env.
 */
import "dotenv/config";
import { createOpenRouterClient } from "../src/llm/openrouter.js";
import {
  buildItemEditPrompt,
  parseItemEditResponse,
  type ItemEditResult,
  type NumberedSpend,
} from "../src/spend/parse.js";

const RECEIPT: NumberedSpend[] = [
  { position: 1, spend: { amount: 350, description: "кофе", tags: ["restaurants"] } },
  { position: 2, spend: { amount: 1200, description: "такси", tags: ["transport"] } },
  { position: 3, spend: { amount: 890, description: "продукты", tags: ["groceries"] } },
  { position: 4, spend: { amount: 450, description: "круассан", tags: ["restaurants"] } },
  { position: 5, spend: { amount: 2000, description: "бензин", tags: ["transport"] } },
];

type Expectation =
  | { action: "delete"; position: number }
  | { action: "update"; position: number; amount?: number; description?: string; tags?: string[] }
  | { action: "error"; reason: ItemEditResult extends { ok: false; reason: infer R } ? R | "any" : never };

const CASES: { correction: string; expect: Expectation }[] = [
  { correction: "удали такси", expect: { action: "delete", position: 2 } },
  { correction: "третью убери", expect: { action: "delete", position: 3 } },
  { correction: "последнюю удали", expect: { action: "delete", position: 5 } },
  { correction: "кофе на самом деле 400", expect: { action: "update", position: 1, amount: 400 } },
  { correction: "второй на самом деле 1300", expect: { action: "update", position: 2, amount: 1300 } },
  { correction: "продукты 900", expect: { action: "update", position: 3, amount: 900 } },
  {
    correction: "круассан переименуй в булочка",
    expect: { action: "update", position: 4, description: "булочка" },
  },
  {
    correction: "такси 1500 это был каршеринг",
    expect: { action: "update", position: 2, amount: 1500 },
  },
  { correction: "бензин это дом и хозяйство", expect: { action: "update", position: 5, tags: ["household"] } },
  { correction: "круассан это готовая еда", expect: { action: "update", position: 4, tags: ["prepared_food"] } },
  { correction: "удали", expect: { action: "error", reason: "ambiguous" } },
  { correction: "на самом деле 700", expect: { action: "error", reason: "ambiguous" } },
  { correction: "удали еду", expect: { action: "error", reason: "ambiguous" } },
  { correction: "привет, как дела?", expect: { action: "error", reason: "any" } },
];

function check(result: ItemEditResult, expected: Expectation): string | null {
  if (expected.action === "error") {
    if (result.ok) return `expected error ${expected.reason}, got ${result.action} @${result.position}`;
    if (expected.reason !== "any" && result.reason !== expected.reason) {
      return `expected error ${expected.reason}, got ${result.reason}`;
    }
    return null;
  }
  if (!result.ok) return `expected ${expected.action} @${expected.position}, got error ${result.reason}: ${result.detail}`;
  if (result.position !== expected.position) return `wrong position: expected ${expected.position}, got ${result.position}`;
  if (result.action !== expected.action) return `wrong action: expected ${expected.action}, got ${result.action}`;
  if (result.action !== "update" || expected.action !== "update") return null;
  const original = RECEIPT.find((item) => item.position === expected.position)!.spend;
  const want = { ...original, ...stripUndefined(expected) };
  if (result.spend.amount !== want.amount) return `amount: expected ${want.amount}, got ${result.spend.amount}`;
  if (expected.description !== undefined && result.spend.description.toLowerCase() !== want.description.toLowerCase()) {
    return `description: expected ${want.description}, got ${result.spend.description}`;
  }
  if ([...result.spend.tags].sort().join() !== [...want.tags].sort().join()) {
    return `tags: expected [${want.tags}], got [${result.spend.tags}]`;
  }
  return null;
}

function stripUndefined(expected: Expectation & { action: "update" }) {
  const out: { amount?: number; description?: string; tags?: string[] } = {};
  if (expected.amount !== undefined) out.amount = expected.amount;
  if (expected.description !== undefined) out.description = expected.description;
  if (expected.tags !== undefined) out.tags = expected.tags;
  return out;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const llm = createOpenRouterClient({
  apiKey: requireEnv("OPENROUTER_API_KEY"),
  model: requireEnv("OPENROUTER_MODEL"),
});
const positions = RECEIPT.map((item) => item.position);

console.log(`Model: ${process.env.OPENROUTER_MODEL}\nReceipt:`);
for (const item of RECEIPT) {
  console.log(`  ${item.position}. ${item.spend.amount} — ${item.spend.description} [${item.spend.tags}]`);
}
console.log("");

let failures = 0;
for (const testCase of CASES) {
  const raw = await llm.complete(buildItemEditPrompt(RECEIPT, testCase.correction));
  const result = parseItemEditResponse(raw, positions);
  const problem = check(result, testCase.expect);
  const status = problem ? "FAIL" : "ok  ";
  const got = result.ok
    ? `${result.action} @${result.position}${result.action === "update" ? " " + JSON.stringify(result.spend) : ""}`
    : `error ${result.reason}`;
  console.log(`${status} «${testCase.correction}» → ${got}`);
  if (problem) {
    failures += 1;
    console.log(`     ${problem}\n     raw: ${raw.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
process.exit(failures === 0 ? 0 : 1);
