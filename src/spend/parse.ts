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

export type ParseListResult =
  | { ok: true; spends: SpendDraft[] }
  | { ok: false; reason: string };

/** Sanity cap — a real receipt never has this many line items. */
const MAX_ITEMS = 100;

/**
 * Prompt for the LLM extraction call. The model must answer with bare JSON:
 * a {"spends": [...]} array (one entry per spend mentioned) or
 * {"error": "not_a_spend"} when the message does not describe a spend.
 */
export function buildExtractionPrompt(messageText: string): string {
  return [
    "You extract spending records from a short user message.",
    "",
    `Allowed tags: ${TAGS.join(", ")}`,
    "",
    "Respond with JSON only, no prose, no code fences. Shape:",
    '{"spends": [{"amount": <positive number>, "description": "<short description>", "tags": ["<tag>", ...]}, ...]}',
    "",
    "Rules:",
    "- One entry per distinct spend mentioned in the message (usually one; e.g. “coffee 5 and taxi 12” is two).",
    "- amount: the money spent on that entry, as a plain number.",
    "- description: short, human-readable, taken from the message.",
    '- tags: 1 or more tags from the allowed list that fit that entry. Use "other" only when nothing else fits.',
    '- If the message describes no spend at all (no amount, or not about spending), respond with {"error": "not_a_spend"}.',
    "",
    "Message:",
    messageText,
  ].join("\n");
}

/**
 * Prompt for extracting a spend from a photo (usually a receipt), sent to the
 * model together with the image. The caption, when present, wins over what the
 * photo shows.
 */
export function buildPhotoExtractionPrompt(caption: string): string {
  const lines = [
    "You extract spending records from a photo — usually a receipt, sometimes a price tag or a payment screenshot.",
    "",
    `Allowed tags: ${TAGS.join(", ")}`,
    "",
    "Respond with JSON only, no prose, no code fences. Shape:",
    '{"spends": [{"amount": <positive number>, "description": "<short description>", "tags": ["<tag>", ...]}, ...]}',
    "",
    "Rules:",
    "- A receipt with multiple line items → one entry PER LINE ITEM: amount is that line's total (after its own discount), description is the item name cleaned up to be human-readable, tags fit that item.",
    "- Do NOT add an extra entry for the receipt's grand total.",
    "- A photo of a single spend (one item, price tag, payment screenshot) → an array with one entry.",
    '- tags: 1 or more tags from the allowed list per entry. Use "other" only when nothing else fits.',
    '- If the photo does not show a spend, respond with {"error": "not_a_spend"}.',
  ];
  if (caption.trim() !== "") {
    lines.push(
      "- The user's caption may correct or add context; it takes precedence over the photo.",
      "",
      "User caption:",
      caption,
    );
  }
  return lines.join("\n");
}

/**
 * Prompt for extracting spends from a voice/audio message, sent to the model
 * together with the audio. Same {"spends": [...]} contract as text and photo.
 */
export function buildAudioExtractionPrompt(caption: string): string {
  const lines = [
    "You extract spending records from a voice message where the user describes what they spent money on.",
    "",
    `Allowed tags: ${TAGS.join(", ")}`,
    "",
    "Respond with JSON only, no prose, no code fences. Shape:",
    '{"spends": [{"amount": <positive number>, "description": "<short description>", "tags": ["<tag>", ...]}, ...]}',
    "",
    "Rules:",
    "- One entry per distinct spend mentioned (usually one; “coffee five euros and taxi twelve” is two).",
    "- amount: the money spent on that entry, as a plain number (spoken numbers like “six fifty” → 6.5).",
    "- description: short and human-readable, based on what was said.",
    '- tags: 1 or more tags from the allowed list that fit that entry. Use "other" only when nothing else fits.',
    '- If the audio does not describe a spend, respond with {"error": "not_a_spend"}.',
  ];
  if (caption.trim() !== "") {
    lines.push(
      "- The user's caption may correct or add context; it takes precedence over the audio.",
      "",
      "User caption:",
      caption,
    );
  }
  return lines.join("\n");
}

/**
 * Prompt for correcting an existing spend from a reply message. The model
 * returns the full updated spend (same shape as extraction), applying only
 * the requested changes.
 */
export function buildEditPrompt(existing: SpendDraft, correctionText: string): string {
  return [
    "You update an existing spending record based on a user's correction message.",
    "",
    `Allowed tags: ${TAGS.join(", ")}`,
    "",
    "Existing spend:",
    JSON.stringify({
      amount: existing.amount,
      description: existing.description,
      tags: existing.tags,
    }),
    "",
    "Respond with the FULL updated spend as JSON only, no prose, no code fences. Shape:",
    '{"amount": <positive number>, "description": "<short description>", "tags": ["<tag>", ...]}',
    "",
    "Rules:",
    "- Apply only the changes the correction asks for; keep every other field unchanged.",
    '- If the correction cannot be understood as a change to this spend, respond with {"error": "not_a_spend"}.',
    "",
    "Correction:",
    correctionText,
  ].join("\n");
}

const DELETE_KEYWORDS = new Set(["delete", "del", "remove"]);

/** True when a reply message asks to delete the spend instead of editing it. */
export function isDeleteRequest(text: string): boolean {
  return DELETE_KEYWORDS.has(text.trim().toLowerCase());
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

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: `model returned non-object JSON: ${truncate(raw)}` };
  }
  const record = data as Record<string, unknown>;

  if (record.error === "not_a_spend") {
    return { ok: false, reason: "message does not describe a spend" };
  }

  return validateSpendObject(record);
}

/**
 * Validates a multi-spend response (photo extraction): {"spends": [...]}.
 * Also tolerates a bare array or a bare single spend object — model noise we
 * can safely accept. All-or-nothing: one invalid entry rejects the whole
 * response, so we never silently save a receipt partially.
 */
export function parseLlmResponseList(raw: string): ParseListResult {
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFences(raw));
  } catch {
    return { ok: false, reason: `model returned non-JSON: ${truncate(raw)}` };
  }

  let items: unknown[];
  if (Array.isArray(data)) {
    items = data;
  } else if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    if (record.error === "not_a_spend") {
      return { ok: false, reason: "message does not describe a spend" };
    }
    if (Array.isArray(record.spends)) {
      items = record.spends;
    } else if ("amount" in record) {
      items = [record];
    } else {
      return { ok: false, reason: `model returned unexpected shape: ${truncate(raw)}` };
    }
  } else {
    return { ok: false, reason: `model returned non-object JSON: ${truncate(raw)}` };
  }

  if (items.length === 0) {
    return { ok: false, reason: "model returned no spends" };
  }
  if (items.length > MAX_ITEMS) {
    return { ok: false, reason: `model returned ${items.length} spends, cap is ${MAX_ITEMS}` };
  }

  const spends: SpendDraft[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, reason: `entry ${index} is not an object` };
    }
    const result = validateSpendObject(item as Record<string, unknown>);
    if (!result.ok) {
      return { ok: false, reason: `entry ${index}: ${result.reason}` };
    }
    spends.push(result.spend);
  }
  return { ok: true, spends };
}

/** Shared per-spend validation; treats the model output as untrusted input. */
function validateSpendObject(record: Record<string, unknown>): ParseResult {
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
