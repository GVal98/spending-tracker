import { describe, expect, it } from "vitest";
import {
  computeStats,
  formatStatsMessage,
  periodElapsedFraction,
  resolvePeriod,
  roundAmount,
} from "./stats.js";

// Tuesday, September 15, 2026, 14:30 local time
const NOW = new Date(2026, 8, 15, 14, 30);

describe("resolvePeriod", () => {
  it("empty_arg_resolves_to_the_current_month", () => {
    const period = resolvePeriod("", NOW);
    expect(period).toEqual({
      label: "Сентябрь 2026",
      kind: "month",
      from: new Date(2026, 8, 1),
      to: new Date(2026, 9, 1),
    });
  });

  it("month_and_empty_arg_resolve_identically", () => {
    expect(resolvePeriod("month", NOW)).toEqual(resolvePeriod("", NOW));
  });

  it("prev_resolves_to_the_previous_month", () => {
    const period = resolvePeriod("prev", NOW);
    expect(period).toEqual({
      label: "Август 2026",
      kind: "month",
      from: new Date(2026, 7, 1),
      to: new Date(2026, 8, 1),
    });
  });

  it("prev_in_january_wraps_to_december_of_previous_year", () => {
    const period = resolvePeriod("prev", new Date(2026, 0, 10));
    expect(period).toEqual({
      label: "Декабрь 2025",
      kind: "month",
      from: new Date(2025, 11, 1),
      to: new Date(2026, 0, 1),
    });
  });

  it("week_starts_on_monday", () => {
    // Sep 15, 2026 is a Tuesday; that week's Monday is Sep 14.
    const period = resolvePeriod("week", NOW);
    expect(period).toEqual({
      label: "Неделя с 14 сентября",
      kind: "week",
      from: new Date(2026, 8, 14),
      to: new Date(2026, 8, 21),
    });
  });

  it("week_on_a_sunday_still_belongs_to_the_monday_started_week", () => {
    // Sep 20, 2026 is a Sunday; its week started Monday Sep 14.
    const period = resolvePeriod("week", new Date(2026, 8, 20, 23, 59));
    expect(period?.from).toEqual(new Date(2026, 8, 14));
    expect(period?.to).toEqual(new Date(2026, 8, 21));
  });

  it("week_crossing_a_month_boundary_is_handled", () => {
    // Sep 2, 2026 is a Wednesday; its week started Monday Aug 31.
    const period = resolvePeriod("week", new Date(2026, 8, 2));
    expect(period?.from).toEqual(new Date(2026, 7, 31));
    expect(period?.label).toBe("Неделя с 31 августа");
  });

  it("arg_is_trimmed_and_case_insensitive", () => {
    expect(resolvePeriod("  WEEK ", NOW)?.label).toBe("Неделя с 14 сентября");
    expect(resolvePeriod("Last", NOW)?.label).toBe("Август 2026");
  });

  it("unknown_arg_resolves_to_undefined", () => {
    expect(resolvePeriod("year", NOW)).toBeUndefined();
    expect(resolvePeriod("2026-01", NOW)).toBeUndefined();
  });
});

describe("computeStats", () => {
  it("returns_zeroes_for_no_spends", () => {
    expect(computeStats([])).toEqual({ total: 0, count: 0, byTag: [] });
  });

  it("counts_a_multi_tag_spend_fully_under_each_tag", () => {
    const stats = computeStats([{ amount: 10, tags: ["restaurants", "entertainment"] }]);
    expect(stats.total).toBe(10);
    expect(stats.byTag).toEqual([
      { tag: "entertainment", total: 10, count: 1 },
      { tag: "restaurants", total: 10, count: 1 },
    ]);
  });

  it("sorts_tags_by_total_desc_then_id", () => {
    const stats = computeStats([
      { amount: 5, tags: ["transport"] },
      { amount: 20, tags: ["groceries"] },
      { amount: 5, tags: ["restaurants"] },
    ]);
    expect(stats.byTag.map((s) => s.tag)).toEqual([
      "groceries",
      "restaurants",
      "transport",
    ]);
  });
});

describe("formatStatsMessage", () => {
  it("reports_an_empty_period", () => {
    expect(formatStatsMessage("Сентябрь 2026", computeStats([]))).toBe(
      "Сентябрь 2026\nНет трат за этот период.",
    );
  });

  it("formats_total_count_and_tag_label_lines", () => {
    const message = formatStatsMessage(
      "Сентябрь 2026",
      computeStats([
        { amount: 6.5, tags: ["restaurants"] },
        { amount: 12, tags: ["transport"] },
      ]),
    );
    expect(message).toBe(
      "Сентябрь 2026\nВсего: 18.5 (2 траты)\n\nТранспорт: 12 (1)\nРестораны и фастфуд: 6.5 (1)",
    );
  });

  it("uses_the_singular_spend_word_for_a_single_record", () => {
    const message = formatStatsMessage("Сентябрь 2026", computeStats([{ amount: 5, tags: ["groceries"] }]));
    expect(message).toContain("(1 трата)");
  });

  it("rounds_float_noise_in_sums", () => {
    const message = formatStatsMessage(
      "Сентябрь 2026",
      computeStats([
        { amount: 0.1, tags: ["groceries"] },
        { amount: 0.2, tags: ["groceries"] },
      ]),
    );
    expect(message).toContain("Всего: 0.3");
    expect(message).toContain("Продукты: 0.3 (2)");
  });
});

describe("roundAmount", () => {
  it("rounds_to_two_decimals", () => {
    expect(roundAmount(0.30000000000000004)).toBe(0.3);
    expect(roundAmount(12)).toBe(12);
    expect(roundAmount(1.005)).toBeCloseTo(1, 1);
  });
});

describe("periodElapsedFraction", () => {
  const september = { from: new Date(2026, 8, 1), to: new Date(2026, 9, 1) };

  it("counts_today_in_full", () => {
    // 15th of a 30-day month, any time of day → half
    expect(periodElapsedFraction(september, new Date(2026, 8, 15, 0, 1))).toBe(0.5);
    expect(periodElapsedFraction(september, new Date(2026, 8, 15, 23, 59))).toBe(0.5);
    expect(periodElapsedFraction(september, new Date(2026, 8, 1))).toBeCloseTo(1 / 30);
  });

  it("is_1_for_a_past_period_and_0_for_a_future_one", () => {
    expect(periodElapsedFraction(september, new Date(2026, 9, 10))).toBe(1);
    expect(periodElapsedFraction(september, new Date(2026, 7, 10))).toBe(0);
  });

  it("works_for_a_week", () => {
    const week = { from: new Date(2026, 8, 14), to: new Date(2026, 8, 21) }; // Mon..Sun
    expect(periodElapsedFraction(week, new Date(2026, 8, 16, 12))).toBeCloseTo(3 / 7); // Wednesday
  });
});
