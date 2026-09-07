import { describe, expect, it } from "vitest";
import {
  formatLimitBar,
  formatLimitUsage,
  limitsForTags,
  sumUnderLimit,
  weeklyLimitAmount,
  type SpendLimit,
} from "./limits.js";

// Config-independent fixture: tests must not break when the user retunes
// the real LIMITS amounts in limits.ts.
const FOOD_LIMIT: SpendLimit = {
  id: "food",
  label: "Еда",
  tags: ["prepared_food", "groceries", "restaurants"],
  monthlyAmount: 30_000,
};

describe("limitsForTags", () => {
  it("returns_limits_whose_tag_set_intersects_the_spend_tags", () => {
    expect(limitsForTags(["groceries"]).map((limit) => limit.id)).toEqual([
      "food",
    ]);
    expect(limitsForTags(["transport"]).map((limit) => limit.id)).toEqual([
      "transport",
    ]);
  });

  it("returns_every_limit_the_tags_touch", () => {
    const ids = limitsForTags(["restaurants", "transport"]).map(
      (limit) => limit.id,
    );
    expect(ids).toEqual(["food", "transport"]);
  });

  it("returns_empty_for_tags_outside_all_limits", () => {
    expect(limitsForTags(["health", "dev_project"])).toEqual([]);
    expect(limitsForTags([])).toEqual([]);
  });
});

describe("sumUnderLimit", () => {
  it("sums_only_spends_with_a_matching_tag", () => {
    const sum = sumUnderLimit(FOOD_LIMIT, [
      { amount: 100, tags: ["groceries"] },
      { amount: 50, tags: ["transport"] },
      { amount: 30, tags: ["restaurants"] },
    ]);
    expect(sum).toBe(130);
  });

  it("counts_a_spend_once_even_when_several_tags_match", () => {
    const sum = sumUnderLimit(FOOD_LIMIT, [
      { amount: 100, tags: ["prepared_food", "restaurants"] },
    ]);
    expect(sum).toBe(100);
  });

  it("counts_a_multi_tag_spend_that_matches_on_one_tag", () => {
    const sum = sumUnderLimit(FOOD_LIMIT, [
      { amount: 100, tags: ["groceries", "delivery_fees"] },
    ]);
    expect(sum).toBe(100);
  });

  it("returns_zero_for_no_spends", () => {
    expect(sumUnderLimit(FOOD_LIMIT, [])).toBe(0);
  });
});

describe("weeklyLimitAmount", () => {
  it("scales_the_monthly_amount_to_seven_days_of_the_month", () => {
    // September has 30 days: 30000 * 7 / 30 = 7000.
    const weekStart = new Date(2026, 8, 14); // Monday, Sep 14
    expect(weeklyLimitAmount(FOOD_LIMIT, weekStart)).toBe(7000);
  });

  it("uses_the_week_start_month_when_the_week_spans_two_months", () => {
    // Monday Aug 31 → August's 31 days apply to the whole week.
    const weekStart = new Date(2026, 7, 31);
    expect(weeklyLimitAmount(FOOD_LIMIT, weekStart)).toBeCloseTo(
      (30_000 * 7) / 31,
      6,
    );
  });

  it("handles_february", () => {
    const weekStart = new Date(2027, 1, 1); // Feb 2027: 28 days
    expect(weeklyLimitAmount(FOOD_LIMIT, weekStart)).toBe(7500);
  });
});

describe("formatLimitBar", () => {
  it("fills_used_share_and_places_the_pace_marker", () => {
    // 6 of 20 cells used, marker after cell 10 (half the period elapsed)
    expect(formatLimitBar(0.31, 0.5)).toBe("[██████░░░░|░░░░░░░░░░]");
  });

  it("shows_spending_ahead_of_pace_as_fill_past_the_marker", () => {
    expect(formatLimitBar(0.75, 0.5)).toBe("[██████████|█████░░░░░]");
  });

  it("puts_the_marker_at_the_edges_for_a_fresh_or_finished_period", () => {
    expect(formatLimitBar(0, 0)).toBe("[|░░░░░░░░░░░░░░░░░░░░]");
    expect(formatLimitBar(0.5, 1)).toBe("[██████████░░░░░░░░░░|]");
  });

  it("caps_the_fill_at_full_when_over_the_limit", () => {
    expect(formatLimitBar(1.4, 0.5)).toBe("[██████████|██████████]");
  });

  it("shows_at_least_one_cell_for_any_spend", () => {
    expect(formatLimitBar(0.001, 0.5)).toBe("[█░░░░░░░░░|░░░░░░░░░░]");
  });

  it("respects_a_custom_width", () => {
    expect(formatLimitBar(0.5, 0.25, 4)).toBe("[█|█░░]");
  });
});

describe("formatLimitUsage", () => {
  it("formats_bar_spent_and_limit", () => {
    expect(formatLimitUsage(12_500, 40_000, 0.5)).toBe(
      "[██████░░░░|░░░░░░░░░░] 12500 / 40000",
    );
  });

  it("rounds_float_noise_and_fractional_allowances_for_display", () => {
    // 40000 * 7 / 30 = 9333.333...
    expect(formatLimitUsage(0.30000000000000004, 9333.333333333334, 0)).toBe(
      "[|█░░░░░░░░░░░░░░░░░░░] 0.3 / 9333.33",
    );
  });

  it("marks_a_reached_limit_with_a_warning", () => {
    expect(formatLimitUsage(40_000, 40_000, 1)).toBe(
      "[████████████████████|] 40000 / 40000 ⚠️",
    );
    expect(formatLimitUsage(42_000, 40_000, 1)).toBe(
      "[████████████████████|] 42000 / 40000 ⚠️",
    );
  });

  it("does_not_warn_just_below_the_limit", () => {
    expect(formatLimitUsage(39_999, 40_000, 1)).toBe(
      "[████████████████████|] 39999 / 40000",
    );
  });
});
