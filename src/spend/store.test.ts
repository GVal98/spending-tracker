import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSpendStore, type SpendStore } from "./store.js";
import type { SpendDraft } from "./parse.js";

const COFFEE: SpendDraft = { amount: 6.5, description: "coffee", tags: ["restaurants"] };
const BUS: SpendDraft = { amount: 2, description: "bus", tags: ["transport"] };

describe("SpendStore", () => {
  let store: SpendStore;

  beforeEach(() => {
    store = createSpendStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("insert_then_listRecent_returns_the_spend", () => {
    const spend = store.insert(COFFEE, "coffee 6.50");
    expect(store.listRecent(10)).toEqual([spend]);
  });

  it("insertMany_saves_all_drafts_with_shared_rawText", () => {
    const spends = store.insertMany([COFFEE, BUS], "[photo]");
    expect(spends).toHaveLength(2);
    expect(spends.map((s) => s.description)).toEqual(["coffee", "bus"]);
    expect(spends.every((s) => s.rawText === "[photo]")).toBe(true);
    expect(store.listRecent(10)).toEqual([...spends].reverse());
  });

  it("insertMany_with_empty_array_saves_nothing", () => {
    expect(store.insertMany([], "[photo]")).toEqual([]);
    expect(store.listRecent(10)).toEqual([]);
  });

  it("listBetween_includes_from_boundary_and_excludes_to_boundary", () => {
    const spend = store.insert(COFFEE, "coffee 6.50");
    const justAfter = new Date(Date.parse(spend.createdAt) + 1).toISOString();
    expect(store.listBetween(spend.createdAt, justAfter)).toEqual([spend]);
    expect(store.listBetween(spend.createdAt, spend.createdAt)).toEqual([]);
    expect(store.listBetween(justAfter, "9999-12-31T00:00:00.000Z")).toEqual([]);
  });

  it("listRecent_returns_newest_first_and_respects_limit", () => {
    store.insert(COFFEE, "coffee 6.50");
    const second = store.insert(BUS, "bus 2");
    const listed = store.listRecent(1);
    expect(listed).toEqual([second]);
  });

  it("findByMessageId_returns_linked_spend", () => {
    const spend = store.insert(COFFEE, "coffee 6.50");
    store.linkMessage(spend.id, 111);
    expect(store.findByMessageId(111)).toEqual(spend);
  });

  it("findByMessageId_returns_undefined_for_unknown_message", () => {
    expect(store.findByMessageId(999)).toBeUndefined();
  });

  it("spend_stays_reachable_from_all_its_linked_messages", () => {
    const spend = store.insert(COFFEE, "coffee 6.50");
    store.linkMessage(spend.id, 111);
    store.linkMessage(spend.id, 222); // e.g. the "Updated:" confirmation
    expect(store.findByMessageId(111)?.id).toBe(spend.id);
    expect(store.findByMessageId(222)?.id).toBe(spend.id);
  });

  it("update_replaces_fields_and_preserves_createdAt", () => {
    const spend = store.insert(COFFEE, "coffee 6.50");
    const updated = store.update(
      spend.id,
      { amount: 7.5, description: "coffee", tags: ["restaurants", "entertainment"] },
      "actually 7.50",
    );
    expect(updated).toEqual({
      id: spend.id,
      amount: 7.5,
      description: "coffee",
      tags: ["restaurants", "entertainment"],
      rawText: "actually 7.50",
      createdAt: spend.createdAt,
    });
    expect(store.listRecent(10)).toEqual([updated]);
  });

  it("update_throws_for_unknown_id", () => {
    expect(() => store.update(42, COFFEE, "x")).toThrow(/not found/);
  });

  it("delete_removes_spend_and_its_message_links", () => {
    const spend = store.insert(COFFEE, "coffee 6.50");
    store.linkMessage(spend.id, 111);
    store.delete(spend.id);
    expect(store.listRecent(10)).toEqual([]);
    expect(store.findByMessageId(111)).toBeUndefined();
  });

  it("delete_throws_for_unknown_id", () => {
    expect(() => store.delete(42)).toThrow(/not found/);
  });
});
