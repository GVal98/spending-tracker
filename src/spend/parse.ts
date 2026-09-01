import { TAGS, type Tag, isTag } from "./tags.js";

/** A spend as extracted from a user message, before persistence. */
export interface SpendDraft {
  amount: number;
  description: string;
  tags: Tag[];
}

export type ParseResult =
  | { ok: true; spend: SpendDraft }
  | { ok: false; reason: string };

/**
 * Prompt for the LLM extraction call. The model must answer with bare JSON:
 * either a spend object or {"error": "not_a_spend"} when the message does not
 * describe a spend.
 */
export function buildExtractionPrompt(messageText: string): string {
  return [
    "You extract a spending record from a short user message.",
    "",
    `Allowed tags: ${TAGS.join(", ")}`,
    "",
    "Respond with JSON only, no prose, no code fences. Shape:",
    '{"amount": <positive number>, "description": "<short description>", "tags": ["<tag>", ...]}',
    "",
    "Rules:",
    "- amount: the money spent, as a plain number.",
    "- description: short, human-readable, taken from the message.",
    "- tags: 1 or more tags from the allowed list that fit the spend. Use \"other\" only when nothing else fits.",
    '- If the message does not describe a spend (no amount, or not about spending), respond with {"error": "not_a_spend"}.',
    "",
    "Message:",
    messageText,
  ].join("\n");
}

/**
 * Validates the raw LLM response into a SpendDraft. Pure; treats the model
 * output as untrusted input. Unknown tags are dropped (model noise), but an
 * invalid amount or empty description rejects the whole parse — better to ask
 * the user to rephrase than to store a wrong record.
 */
export function parseLlmResponse(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFences(raw));
  } catch {
    return { ok: false, reason: `model returned non-JSON: ${truncate(raw)}` };
  }

  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: `model returned non-object JSON: ${truncate(raw)}` };
  }
  const record = data as Record<string, unknown>;

  if (record.error === "not_a_spend") {
    return { ok: false, reason: "message does not describe a spend" };
  }

  const amount = record.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: `invalid amount: ${JSON.stringify(amount)}` };
  }

  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  if (description === "") {
    return { ok: false, reason: "missing description" };
  }

  const rawTags = Array.isArray(record.tags) ? record.tags : [];
  const tags = unique(rawTags.filter((tag): tag is Tag => typeof tag === "string" && isTag(tag)));
  if (tags.length === 0) {
    tags.push("other");
  }

  return { ok: true, spend: { amount, description, tags } };
}

/** Models sometimes wrap JSON in ```json fences despite instructions. */
function stripCodeFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}
