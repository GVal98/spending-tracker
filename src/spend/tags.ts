/**
 * Hardcoded tag list for the MVP (dynamic tags are a planned follow-up).
 * A spend can carry any number of these.
 */
export const TAGS = [
  "food",
  "groceries",
  "transport",
  "home",
  "health",
  "fun",
  "subscriptions",
  "travel",
  "shopping",
  "other",
] as const;

export type Tag = (typeof TAGS)[number];

export function isTag(value: string): value is Tag {
  return (TAGS as readonly string[]).includes(value);
}
