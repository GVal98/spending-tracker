/**
 * Tag definitions for the MVP (dynamic tags are a planned follow-up).
 * A spend can carry any number of these.
 *
 * - `id` is the stable contract: stored in the DB (tags JSON) and required in
 *   LLM output. Renaming a label or rewording a hint never touches stored data.
 * - `label` is what the user sees in confirmations and /stats.
 * - `hint` is embedded in extraction prompts; its job is to draw the boundary
 *   between adjacent tags (prepared_food vs restaurants vs groceries, telecom
 *   vs other_subscriptions), so keep the NOT-clauses when editing.
 *
 * `other` must stay in the list: parse falls back to it when the model
 * returns no valid tag.
 */
export const TAGS = [
  {
    id: "rent_utilities",
    label: "Квартира и ЖКУ",
    hint: "rent and apartment utilities: electricity, water, heating, service charges. NOT home internet (telecom)",
  },
  {
    id: "transport",
    label: "Транспорт",
    hint: "getting around town: metro, bus, taxi, car sharing, fuel, parking",
  },
  {
    id: "household",
    label: "Дом и хозяйство",
    hint: "things for the home: cleaning supplies, dishes, tools, furniture, repairs",
  },
  {
    id: "prepared_food",
    label: "Готовая еда",
    hint: "ready-to-eat food eaten at home: cooked dishes from a store, food delivery orders. NOT eating out (restaurants), NOT raw ingredients (groceries)",
  },
  {
    id: "groceries",
    label: "Продукты",
    hint: "food ingredients and basic groceries from a store or market",
  },
  {
    id: "restaurants",
    label: "Рестораны и фастфуд",
    hint: "eating and drinking out: restaurants, cafes, bars, coffee shops, fast food",
  },
  {
    id: "health",
    label: "Здоровье и уход",
    hint: "pharmacy, doctors, tests, dental, cosmetics, haircuts, personal care",
  },
  {
    id: "entertainment",
    label: "Развлечения",
    hint: "movies, concerts, games, hobbies, books, events",
  },
  {
    id: "telecom",
    label: "Интернет и связь",
    hint: "mobile plan, home internet",
  },
  {
    id: "dev_project",
    label: "Разработка и проект",
    hint: "the user's own projects and development: hosting, domains, API credits, dev tools and services",
  },
  {
    id: "other_subscriptions",
    label: "Другие подписки",
    hint: "recurring subscriptions not covered by telecom or dev_project: streaming, music, apps, cloud storage",
  },
  {
    id: "delivery_fees",
    label: "Доставка и сборы",
    hint: "delivery charges, service fees, commissions, courier tips. The delivered goods themselves go under their own tag",
  },
  {
    id: "clothes",
    label: "Одежда и обувь",
    hint: "clothing, shoes, accessories",
  },
  {
    id: "travel",
    label: "Путешествия",
    hint: "trips: flights, trains, hotels, visas, spending while travelling",
  },
  {
    id: "other",
    label: "Другое",
    hint: "only when no other tag fits",
  },
] as const;

export type TagDef = (typeof TAGS)[number];
export type Tag = TagDef["id"];

const labelById: ReadonlyMap<string, string> = new Map(
  TAGS.map((tagDef) => [tagDef.id, tagDef.label]),
);

export function isTag(value: string): value is Tag {
  return labelById.has(value);
}

export function tagLabel(tag: Tag): string {
  const label = labelById.get(tag);
  if (label === undefined) {
    // Unreachable through the type system; guards against unvalidated DB rows.
    throw new Error(`unknown tag: ${tag}`);
  }
  return label;
}
