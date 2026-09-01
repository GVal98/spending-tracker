import { describe, expect, it } from "vitest";
import { ruPlural } from "./ruPlural.js";

describe("ruPlural", () => {
  const spendWord = (count: number) => ruPlural(count, "трата", "траты", "трат");

  it.each([1, 21, 101])("uses_the_one_form_for_%s", (count) => {
    expect(spendWord(count)).toBe("трата");
  });

  it.each([2, 3, 4, 22, 104])("uses_the_few_form_for_%s", (count) => {
    expect(spendWord(count)).toBe("траты");
  });

  it.each([0, 5, 10, 19, 100])("uses_the_many_form_for_%s", (count) => {
    expect(spendWord(count)).toBe("трат");
  });

  it.each([11, 12, 13, 14, 111, 114])(
    "teens_use_the_many_form_despite_their_last_digit_%s",
    (count) => {
      expect(spendWord(count)).toBe("трат");
    },
  );
});
