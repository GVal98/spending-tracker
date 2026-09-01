import { describe, expect, it } from "vitest";
import {
  buildAudioExtractionPrompt,
  buildEditPrompt,
  buildExtractionPrompt,
  buildPhotoExtractionPrompt,
  isDeleteRequest,
  parseLlmResponse,
  parseLlmResponseList,
} from "./parse.js";
import { TAGS } from "./tags.js";

describe("parseLlmResponse", () => {
  it("accepts_a_valid_spend", () => {
    const result = parseLlmResponse(
      '{"amount": 6.5, "description": "coffee with Anna", "tags": ["restaurants", "entertainment"]}',
    );
    expect(result).toEqual({
      ok: true,
      spend: {
        amount: 6.5,
        description: "coffee with Anna",
        tags: ["restaurants", "entertainment"],
      },
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
      '{"amount": 5, "description": "snack", "tags": ["groceries", "made-up-tag"]}',
    );
    expect(result).toMatchObject({ ok: true, spend: { tags: ["groceries"] } });
  });

  it("falls_back_to_other_when_no_valid_tags_remain", () => {
    const result = parseLlmResponse(
      '{"amount": 5, "description": "mystery", "tags": ["nonsense"]}',
    );
    expect(result).toMatchObject({ ok: true, spend: { tags: ["other"] } });
  });

  it("deduplicates_tags", () => {
    const result = parseLlmResponse(
      '{"amount": 5, "description": "lunch", "tags": ["restaurants", "restaurants"]}',
    );
    expect(result).toMatchObject({ ok: true, spend: { tags: ["restaurants"] } });
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
    ["missing", '{"description": "x", "tags": ["groceries"]}'],
    ["zero", '{"amount": 0, "description": "x", "tags": ["groceries"]}'],
    ["negative", '{"amount": -3, "description": "x", "tags": ["groceries"]}'],
    ["string", '{"amount": "6.50", "description": "x", "tags": ["groceries"]}'],
    ["infinite", '{"amount": 1e999, "description": "x", "tags": ["groceries"]}'],
  ])("rejects_%s_amount", (_label, raw) => {
    expect(parseLlmResponse(raw).ok).toBe(false);
  });

  it("rejects_missing_or_blank_description", () => {
    expect(parseLlmResponse('{"amount": 5, "tags": ["groceries"]}').ok).toBe(false);
    expect(
      parseLlmResponse('{"amount": 5, "description": "   ", "tags": ["groceries"]}').ok,
    ).toBe(false);
  });

  it("tolerates_missing_tags_field_with_other_fallback", () => {
    const result = parseLlmResponse('{"amount": 5, "description": "thing"}');
    expect(result).toMatchObject({ ok: true, spend: { tags: ["other"] } });
  });
});

describe("buildExtractionPrompt", () => {
  it("includes_the_message_and_every_tag_id_label_and_hint", () => {
    const prompt = buildExtractionPrompt("coffee 3.20");
    expect(prompt).toContain("coffee 3.20");
    for (const tagDef of TAGS) {
      expect(prompt).toContain(`- ${tagDef.id} (${tagDef.label}): ${tagDef.hint}`);
    }
  });
});

describe("parseLlmResponseList", () => {
  it("accepts_multiple_spends_in_receipt_order", () => {
    const result = parseLlmResponseList(
      '{"spends": [' +
        '{"amount": 2.1, "description": "milk", "tags": ["groceries"]},' +
        '{"amount": 5.99, "description": "wine", "tags": ["entertainment"]}]}',
    );
    expect(result).toEqual({
      ok: true,
      spends: [
        { amount: 2.1, description: "milk", tags: ["groceries"] },
        { amount: 5.99, description: "wine", tags: ["entertainment"] },
      ],
    });
  });

  it("accepts_a_bare_array", () => {
    const result = parseLlmResponseList(
      '[{"amount": 2, "description": "bus", "tags": ["transport"]}]',
    );
    expect(result).toMatchObject({ ok: true, spends: [{ description: "bus" }] });
  });

  it("wraps_a_bare_single_spend_object", () => {
    const result = parseLlmResponseList(
      '{"amount": 6.5, "description": "coffee", "tags": ["restaurants"]}',
    );
    expect(result).toMatchObject({ ok: true, spends: [{ amount: 6.5 }] });
  });

  it("rejects_not_a_spend_marker", () => {
    expect(parseLlmResponseList('{"error": "not_a_spend"}').ok).toBe(false);
  });

  it("rejects_an_empty_spends_array", () => {
    expect(parseLlmResponseList('{"spends": []}').ok).toBe(false);
  });

  it("rejects_the_whole_response_when_one_entry_is_invalid", () => {
    const result = parseLlmResponseList(
      '{"spends": [' +
        '{"amount": 2.1, "description": "milk", "tags": ["groceries"]},' +
        '{"amount": -1, "description": "broken", "tags": ["groceries"]}]}',
    );
    expect(result).toEqual({
      ok: false,
      reason: 'entry 1: invalid amount: -1',
    });
  });

  it("rejects_non_object_entries", () => {
    expect(parseLlmResponseList('{"spends": [42]}').ok).toBe(false);
  });

  it("rejects_more_than_100_entries", () => {
    const entry = '{"amount": 1, "description": "x", "tags": ["other"]}';
    const raw = `{"spends": [${Array(101).fill(entry).join(",")}]}`;
    expect(parseLlmResponseList(raw)).toMatchObject({ ok: false });
  });

  it("rejects_non_json_and_unexpected_shapes", () => {
    expect(parseLlmResponseList("not json").ok).toBe(false);
    expect(parseLlmResponseList('{"hello": "world"}').ok).toBe(false);
    expect(parseLlmResponseList("42").ok).toBe(false);
  });

  it("accepts_json_wrapped_in_code_fences", () => {
    const result = parseLlmResponseList(
      '```json\n{"spends": [{"amount": 2, "description": "bus", "tags": ["transport"]}]}\n```',
    );
    expect(result.ok).toBe(true);
  });
});

describe("buildPhotoExtractionPrompt", () => {
  it("includes_every_tag_id_label_and_hint", () => {
    const prompt = buildPhotoExtractionPrompt("");
    for (const tagDef of TAGS) {
      expect(prompt).toContain(`- ${tagDef.id} (${tagDef.label}): ${tagDef.hint}`);
    }
  });

  it("includes_the_caption_when_present", () => {
    const prompt = buildPhotoExtractionPrompt("groceries 23.40");
    expect(prompt).toContain("User caption:");
    expect(prompt).toContain("groceries 23.40");
  });

  it("omits_the_caption_section_when_caption_is_blank", () => {
    expect(buildPhotoExtractionPrompt("")).not.toContain("User caption:");
    expect(buildPhotoExtractionPrompt("   ")).not.toContain("User caption:");
  });
});

describe("buildAudioExtractionPrompt", () => {
  it("includes_every_tag_id_label_and_hint", () => {
    const prompt = buildAudioExtractionPrompt("");
    for (const tagDef of TAGS) {
      expect(prompt).toContain(`- ${tagDef.id} (${tagDef.label}): ${tagDef.hint}`);
    }
  });

  it("includes_the_caption_only_when_present", () => {
    expect(buildAudioExtractionPrompt("half was for mom")).toContain("half was for mom");
    expect(buildAudioExtractionPrompt("")).not.toContain("User caption:");
  });
});

describe("buildEditPrompt", () => {
  it("includes_existing_spend_correction_and_allowed_tags", () => {
    const prompt = buildEditPrompt(
      { amount: 6.5, description: "coffee with Anna", tags: ["restaurants"] },
      "actually 7.50",
    );
    expect(prompt).toContain('"amount":6.5');
    expect(prompt).toContain("coffee with Anna");
    expect(prompt).toContain("actually 7.50");
    for (const tagDef of TAGS) {
      expect(prompt).toContain(`- ${tagDef.id} (${tagDef.label}): ${tagDef.hint}`);
    }
  });
});

describe("isDeleteRequest", () => {
  it.each(["delete", "Delete", " DELETE ", "del", "remove", "удали", "Удалить", " УБЕРИ "])(
    "recognizes_%s_as_delete",
    (text) => {
      expect(isDeleteRequest(text)).toBe(true);
    },
  );

  it.each(["", "actually 7.50", "delete the tag", "removed", "удали тег"])(
    "does_not_treat_%s_as_delete",
    (text) => {
      expect(isDeleteRequest(text)).toBe(false);
    },
  );
});
