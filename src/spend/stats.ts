import type { Tag } from "./tags.js";

/**
 * Period resolution and stats aggregation for /stats. Pure — boundaries are
 * computed in the machine's local time (the bot runs on the owner's machine,
 * so local time is the owner's time); `from` is inclusive, `to` exclusive.
 */

export interface Period {
  label: string;
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

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Known args: "" or "month" → this month; "prev"/"last" → previous month; "week" → this ISO week. */
export function resolvePeriod(arg: string, now: Date): Period | undefined {
  const normalized = arg.trim().toLowerCase();
  if (normalized === "" || normalized === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { label: monthLabel(from), from, to };
  }
  if (normalized === "prev" || normalized === "last") {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 1);
    return { label: monthLabel(from), from, to };
  }
  if (normalized === "week") {
    const daysSinceMonday = (now.getDay() + 6) % 7; // getDay(): Sunday = 0
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday + 7);
    return { label: `Week of ${MONTHS[from.getMonth()]} ${from.getDate()}`, from, to };
  }
  return undefined;
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
    return `${label}\nNo spends in this period.`;
  }
  const spendWord = stats.count === 1 ? "spend" : "spends";
  const tagLines = stats.byTag.map(
    (stat) => `${stat.tag}: ${roundAmount(stat.total)} (${stat.count})`,
  );
  // Per-tag totals overlap (multi-tag spends count under each tag), so the
  // overall total is reported separately, never summed from the rows.
  return [`${label}`, `Total: ${roundAmount(stats.total)} (${stats.count} ${spendWord})`, "", ...tagLines].join("\n");
}

/** Sums of REAL amounts accumulate float noise (6.5 + 2.99 + ...); round for display. */
export function roundAmount(amount: number): number {
  return Number(amount.toFixed(2));
}

function monthLabel(monthStart: Date): string {
  return `${MONTHS[monthStart.getMonth()]} ${monthStart.getFullYear()}`;
}
