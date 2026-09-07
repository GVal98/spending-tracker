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

/** Cells in a limit bar; the bar is meant for a monospace block. */
export const LIMIT_BAR_WIDTH = 20;

/**
 * "[██████|░░░░░░░░░░░░░░] 12500 / 40000", plus a warning marker once the
 * limit is reached. `elapsedFraction` (0..1) is how much of the period has
 * passed: the `|` pace marker sits there, so filling past it means spending
 * ahead of a linear pace. Callers prepend the limit label / period wording.
 */
export function formatLimitUsage(
  spent: number,
  limitAmount: number,
  elapsedFraction: number,
): string {
  const warning = spent >= limitAmount ? " ⚠️" : "";
  return `${formatLimitBar(spent / limitAmount, elapsedFraction)} ${roundAmount(spent)} / ${roundAmount(limitAmount)}${warning}`;
}

/**
 * Bar of `width` cells: `usedFraction` of them filled, capped at full, and a
 * `|` marker inserted at `elapsedFraction`. Anything spent shows at least
 * one cell so a fresh small spend is visible.
 */
export function formatLimitBar(
  usedFraction: number,
  elapsedFraction: number,
  width = LIMIT_BAR_WIDTH,
): string {
  const rounded = Math.round(usedFraction * width);
  const filled = Math.min(width, usedFraction > 0 ? Math.max(1, rounded) : 0);
  const marker = Math.min(width, Math.max(0, Math.round(elapsedFraction * width)));
  const cells = "█".repeat(filled) + "░".repeat(width - filled);
  return `[${cells.slice(0, marker)}|${cells.slice(marker)}]`;
}
