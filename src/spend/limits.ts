import { roundAmount } from "./stats.js";
import type { Tag } from "./tags.js";

/**
 * Hardcoded spending limits (like tags — dynamic management is a planned
 * follow-up; changing an amount means editing this file and restarting).
 *
 * A limit covers a set of tags; a spend counts toward the limit — once, with
 * its full amount — when at least one of its tags is in that set. Limits may
 * overlap each other; that's two views of the same spend, not double counting.
 *
 * Only monthly amounts are configured. The weekly allowance is derived from
 * the monthly one at the same daily pace (see weeklyLimitAmount), so weekly
 * tracking never needs its own number.
 */
export interface SpendLimit {
  id: string;
  /** Shown in bot messages. */
  label: string;
  tags: readonly Tag[];
  monthlyAmount: number;
}

export const LIMITS: readonly SpendLimit[] = [
  {
    id: "food",
    label: "Еда",
    tags: ["prepared_food", "groceries", "restaurants"],
    monthlyAmount: 40_000,
  },
  {
    id: "transport",
    label: "Транспорт",
    tags: ["transport"],
    monthlyAmount: 15_000,
  },
];

/** Limits that a spend with these tags counts toward. */
export function limitsForTags(tags: readonly Tag[]): SpendLimit[] {
  return LIMITS.filter((limit) => limit.tags.some((tag) => tags.includes(tag)));
}

/** Sum of the spends that count toward the limit; a multi-tag spend counts once. */
export function sumUnderLimit(
  limit: SpendLimit,
  spends: readonly { amount: number; tags: readonly Tag[] }[],
): number {
  let sum = 0;
  for (const spend of spends) {
    if (spend.tags.some((tag) => limit.tags.includes(tag))) {
      sum += spend.amount;
    }
  }
  return sum;
}

/**
 * Weekly allowance at the monthly limit's daily pace: monthly * 7 / days in
 * the month. For a week spanning two months the month of `weekStart` (Monday)
 * is used — a pace indicator doesn't warrant day-by-day proration.
 */
export function weeklyLimitAmount(limit: SpendLimit, weekStart: Date): number {
  const daysInMonth = new Date(
    weekStart.getFullYear(),
    weekStart.getMonth() + 1,
    0,
  ).getDate();
  return (limit.monthlyAmount * 7) / daysInMonth;
}

/**
 * "12500 / 40000 (31%)", plus a warning marker once the limit is reached.
 * Callers prepend the limit label and period wording.
 */
export function formatLimitUsage(spent: number, limitAmount: number): string {
  const percent = Math.round((spent / limitAmount) * 100);
  const warning = spent >= limitAmount ? " ⚠️" : "";
  return `${roundAmount(spent)} / ${roundAmount(limitAmount)} (${percent}%)${warning}`;
}
