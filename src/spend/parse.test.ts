import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, parseLlmResponse } from "./parse.js";
import { TAGS } from "./tags.js";

describe("parseLlmResponse", () => {
  it("accepts_a_valid_spend", () => {
    const result = parseLlmResponse(
      '{"amount": 6.5, "description": "coffee with Anna", "tags": ["food", "fun"]}',
    );
    expect(result).toEqual({
      ok: true,
      spend: { amount: 6.5, description: "coffee with Anna", tags: ["food", "fun"] },
    });
  });

  it("accepts_json_wrapped_in_code_fences", () => {
    const result = parseLlmResponse(
      '```json\n{"amount": 10, "description": "bus ticket", "tags": ["transport"]}\n```',
    );
    expect(result.ok).toBe(true);
  });

  it("drops_unknown_tags_but_keeps_valid_ones", () => {
    const result = parseLlmResponse(
      '{"amount": 5, "description": "snack", "tags": ["food", "made-up-tag"]}',
    );
    expect(result).toMatchObject({ ok: true, spend: { tags: ["food"] } });
  });

  it("falls_back_to_other_when_no_valid_tags_remain", () => {
    const result = parseLlmResponse(
      '{"amount": 5, "description": "mystery", "tags": ["nonsense"]}',
    );
    expect(result).toMatchObject({ ok: true, spend: { tags: ["other"] } });
  });

  it("deduplicates_tags", () => {
    const result = parseLlmResponse(
      '{"amount": 5, "description": "lunch", "tags": ["food", "food"]}',
    );
    expect(result).toMatchObject({ ok: true, spend: { tags: ["food"] } });
  });

  it("rejects_not_a_spend_marker", () => {
    const result = parseLlmResponse('{"error": "not_a_spend"}');
    expect(result).toEqual({ ok: false, reason: "message does not describe a spend" });
  });

  it("rejects_non_json", () => {
    expect(parseLlmResponse("sure, here is your JSON!").ok).toBe(false);
  });

  it("rejects_non_object_json", () => {
    expect(parseLlmResponse("[1, 2, 3]").ok).toBe(false);
    expect(parseLlmResponse("42").ok).toBe(false);
    expect(parseLlmResponse("null").ok).toBe(false);
  });

  it.each([
    ["missing", '{"description": "x", "tags": ["food"]}'],
    ["zero", '{"amount": 0, "description": "x", "tags": ["food"]}'],
    ["negative", '{"amount": -3, "description": "x", "tags": ["food"]}'],
    ["string", '{"amount": "6.50", "description": "x", "tags": ["food"]}'],
    ["infinite", '{"amount": 1e999, "description": "x", "tags": ["food"]}'],
  ])("rejects_%s_amount", (_label, raw) => {
    expect(parseLlmResponse(raw).ok).toBe(false);
  });

  it("rejects_missing_or_blank_description", () => {
    expect(parseLlmResponse('{"amount": 5, "tags": ["food"]}').ok).toBe(false);
    expect(
      parseLlmResponse('{"amount": 5, "description": "   ", "tags": ["food"]}').ok,
    ).toBe(false);
  });

  it("tolerates_missing_tags_field_with_other_fallback", () => {
    const result = parseLlmResponse('{"amount": 5, "description": "thing"}');
    expect(result).toMatchObject({ ok: true, spend: { tags: ["other"] } });
  });
});

describe("buildExtractionPrompt", () => {
  it("includes_the_message_and_every_allowed_tag", () => {
    const prompt = buildExtractionPrompt("coffee 3.20");
    expect(prompt).toContain("coffee 3.20");
    for (const tag of TAGS) {
      expect(prompt).toContain(tag);
    }
  });
});
