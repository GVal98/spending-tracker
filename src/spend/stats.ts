import { ruPlural } from "../ruPlural.js";
import { tagLabel, type Tag } from "./tags.js";

/**
 * Period resolution and stats aggregation for /stats. Pure — boundaries are
 * computed in the machine's local time (the bot runs on the owner's machine,
 * so local time is the owner's time); `from` is inclusive, `to` exclusive.
 */

export interface Period {
  label: string;
  /** Month-shaped vs week-shaped period — decides which limit allowance applies. */
  kind: "month" | "week";
  from: Date;
  to: Date;
}

export interface TagStat {
  tag: Tag;
  total: number;
  count: number;
}

export interface SpendStats {
  total: number;
  count: number;
  /** Sorted by total desc. A spend counts fully under each of its tags. */
  byTag: TagStat[];
}

// Two case forms: nominative for a month label (“Сентябрь 2026”), genitive
// after a day number (“Неделя с 14 сентября”).
const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
] as const;
const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
] as const;

/** Known args: "" or "month" → this month; "prev"/"last" → previous month; "week" → this ISO week. */
export function resolvePeriod(arg: string, now: Date): Period | undefined {
  const normalized = arg.trim().toLowerCase();
  if (normalized === "" || normalized === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { label: monthLabel(from), kind: "month", from, to };
  }
  if (normalized === "prev" || normalized === "last") {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 1);
    return { label: monthLabel(from), kind: "month", from, to };
  }
  if (normalized === "week") {
    const daysSinceMonday = (now.getDay() + 6) % 7; // getDay(): Sunday = 0
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday + 7);
    return { label: `Неделя с ${from.getDate()} ${MONTHS_GENITIVE[from.getMonth()]}`, kind: "week", from, to };
  }
  return undefined;
}

/**
 * Share of the period elapsed, 0..1, with today counted in full: on the 15th
 * of a 30-day month it is 0.5. Clamped, so a past period is 1 and a future
 * one 0.
 */
export function periodElapsedFraction(period: Pick<Period, "from" | "to">, now: Date): number {
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const fraction =
    (endOfToday.getTime() - period.from.getTime()) / (period.to.getTime() - period.from.getTime());
  return Math.min(1, Math.max(0, fraction));
}

export function computeStats(
  spends: readonly { amount: number; tags: readonly Tag[] }[],
): SpendStats {
  const byTag = new Map<Tag, TagStat>();
  let total = 0;
  for (const spend of spends) {
    total += spend.amount;
    for (const tag of spend.tags) {
      const stat = byTag.get(tag) ?? { tag, total: 0, count: 0 };
      stat.total += spend.amount;
      stat.count += 1;
      byTag.set(tag, stat);
    }
  }
  const sorted = [...byTag.values()].sort(
    (a, b) => b.total - a.total || a.tag.localeCompare(b.tag),
  );
  return { total, count: spends.length, byTag: sorted };
}

export function formatStatsMessage(label: string, stats: SpendStats): string {
  if (stats.count === 0) {
    return `${label}\nНет трат за этот период.`;
  }
  const spendWord = ruPlural(stats.count, "трата", "траты", "трат");
  const tagLines = stats.byTag.map(
    (stat) => `${tagLabel(stat.tag)}: ${roundAmount(stat.total)} (${stat.count})`,
  );
  // Per-tag totals overlap (multi-tag spends count under each tag), so the
  // overall total is reported separately, never summed from the rows.
  return [`${label}`, `Всего: ${roundAmount(stats.total)} (${stats.count} ${spendWord})`, "", ...tagLines].join("\n");
}

/** Sums of REAL amounts accumulate float noise (6.5 + 2.99 + ...); round for display. */
export function roundAmount(amount: number): number {
  return Number(amount.toFixed(2));
}

function monthLabel(monthStart: Date): string {
  return `${MONTHS[monthStart.getMonth()]} ${monthStart.getFullYear()}`;
}
