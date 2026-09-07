import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("findByMessageId_returns_linked_spend_at_position_1", () => {
    const spend = store.insert(COFFEE, "coffee 6.50");
    store.linkMessage(111, [spend.id]);
    expect(store.findByMessageId(111)).toEqual([{ position: 1, spend }]);
  });

  it("findByMessageId_returns_items_in_message_order", () => {
    const [coffee, bus] = store.insertMany([COFFEE, BUS], "[photo]");
    store.linkMessage(111, [coffee!.id, bus!.id]);
    expect(store.findByMessageId(111)).toEqual([
      { position: 1, spend: coffee },
      { position: 2, spend: bus },
    ]);
  });

  it("findByMessageId_returns_empty_for_unknown_message", () => {
    expect(store.findByMessageId(999)).toEqual([]);
  });

  it("linkMessage_replaces_previous_links_of_that_message", () => {
    const [coffee, bus] = store.insertMany([COFFEE, BUS], "[photo]");
    store.linkMessage(111, [coffee!.id, bus!.id]);
    store.linkMessage(111, [bus!.id]);
    expect(store.findByMessageId(111)).toEqual([{ position: 1, spend: bus }]);
  });

  it("linkMessage_throws_for_zero_spends", () => {
    expect(() => store.linkMessage(111, [])).toThrow(/zero spends/);
  });

  it("spend_stays_reachable_from_all_its_linked_messages", () => {
    const spend = store.insert(COFFEE, "coffee 6.50");
    store.linkMessage(111, [spend.id]);
    store.linkMessage(222, [spend.id]); // e.g. the "Updated:" confirmation
    expect(store.findByMessageId(111)[0]?.spend?.id).toBe(spend.id);
    expect(store.findByMessageId(222)[0]?.spend?.id).toBe(spend.id);
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

  it("delete_removes_spend_but_keeps_its_message_position_as_null", () => {
    const [coffee, bus] = store.insertMany([COFFEE, BUS], "[photo]");
    store.linkMessage(111, [coffee!.id, bus!.id]);
    store.delete(coffee!.id);
    expect(store.listRecent(10)).toEqual([bus]);
    expect(store.findByMessageId(111)).toEqual([
      { position: 1, spend: null },
      { position: 2, spend: bus },
    ]);
  });

  it("delete_throws_for_unknown_id", () => {
    expect(() => store.delete(42)).toThrow(/not found/);
  });
});

describe("spend_messages migration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spend-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites_v1_single_spend_links_as_position_1", () => {
    const dbPath = join(dir, "v1.db");
    const v1 = new Database(dbPath);
    v1.exec(`
      CREATE TABLE spends (
        id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL NOT NULL, description TEXT NOT NULL,
        tags TEXT NOT NULL, raw_text TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE spend_messages (
        telegram_message_id INTEGER PRIMARY KEY,
        spend_id INTEGER NOT NULL REFERENCES spends(id)
      );
      INSERT INTO spends (amount, description, tags, raw_text, created_at)
        VALUES (6.5, 'coffee', '["restaurants"]', 'coffee 6.50', '2026-01-01T00:00:00.000Z');
      INSERT INTO spend_messages (telegram_message_id, spend_id) VALUES (111, 1), (222, 1);
    `);
    v1.close();

    const store = createSpendStore(dbPath);
    expect(store.findByMessageId(111)).toEqual([
      { position: 1, spend: expect.objectContaining({ id: 1, description: "coffee" }) },
    ]);
    expect(store.findByMessageId(222)).toHaveLength(1);
    // v2 shape: several positions per message are now allowed.
    const bus = store.insert(BUS, "bus 2");
    store.linkMessage(333, [1, bus.id]);
    expect(store.findByMessageId(333)).toHaveLength(2);
    store.close();
  });

  it("reopening_a_v2_database_is_a_no_op", () => {
    const dbPath = join(dir, "v2.db");
    const first = createSpendStore(dbPath);
    const spend = first.insert(COFFEE, "coffee 6.50");
    first.linkMessage(111, [spend.id]);
    first.close();

    const second = createSpendStore(dbPath);
    expect(second.findByMessageId(111)).toEqual([{ position: 1, spend }]);
    second.close();
  });
});
