import Database from "better-sqlite3";
import type { SpendDraft } from "./parse.js";
import type { Tag } from "./tags.js";

export interface Spend extends SpendDraft {
  id: number;
  rawText: string;
  createdAt: string; // ISO 8601 UTC
}

export interface SpendStore {
  insert(draft: SpendDraft, rawText: string): Spend;
  /** Inserts all drafts in one transaction — a receipt is saved fully or not at all. */
  insertMany(drafts: SpendDraft[], rawText: string): Spend[];
  /** Full replacement of amount/description/tags; createdAt is preserved. */
  update(id: number, draft: SpendDraft, rawText: string): Spend;
  /** Removes the spend and its message links. Throws if the id is unknown. */
  delete(id: number): void;
  /** Associates a bot confirmation message with a spend for reply-to lookups. */
  linkMessage(spendId: number, telegramMessageId: number): void;
  findByMessageId(telegramMessageId: number): Spend | undefined;
  listRecent(limit: number): Spend[];
  close(): void;
}

interface SpendRow {
  id: number;
  amount: number;
  description: string;
  tags: string;
  raw_text: string;
  created_at: string;
}

export function createSpendStore(dbPath: string): SpendStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS spends (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      amount      REAL    NOT NULL,
      description TEXT    NOT NULL,
      tags        TEXT    NOT NULL, -- JSON array of tag names
      raw_text    TEXT    NOT NULL, -- original user message
      created_at  TEXT    NOT NULL  -- ISO 8601 UTC
    );
    -- One spend can have several confirmation messages (original + edits),
    -- each of which must resolve back to the spend on reply.
    CREATE TABLE IF NOT EXISTS spend_messages (
      telegram_message_id INTEGER PRIMARY KEY,
      spend_id            INTEGER NOT NULL REFERENCES spends(id)
    );
  `);

  const insertStatement = db.prepare(
    `INSERT INTO spends (amount, description, tags, raw_text, created_at)
     VALUES (@amount, @description, @tags, @rawText, @createdAt)`,
  );
  const updateStatement = db.prepare(
    `UPDATE spends
     SET amount = @amount, description = @description, tags = @tags, raw_text = @rawText
     WHERE id = @id`,
  );
  const selectByIdStatement = db.prepare(
    `SELECT id, amount, description, tags, raw_text, created_at FROM spends WHERE id = ?`,
  );
  const selectByMessageIdStatement = db.prepare(
    `SELECT s.id, s.amount, s.description, s.tags, s.raw_text, s.created_at
     FROM spend_messages m JOIN spends s ON s.id = m.spend_id
     WHERE m.telegram_message_id = ?`,
  );
  const listStatement = db.prepare(
    `SELECT id, amount, description, tags, raw_text, created_at
     FROM spends ORDER BY id DESC LIMIT ?`,
  );
  const linkMessageStatement = db.prepare(
    `INSERT OR REPLACE INTO spend_messages (telegram_message_id, spend_id)
     VALUES (?, ?)`,
  );
  const deleteSpendStatement = db.prepare(`DELETE FROM spends WHERE id = ?`);
  const deleteLinksStatement = db.prepare(
    `DELETE FROM spend_messages WHERE spend_id = ?`,
  );

  const deleteTransaction = db.transaction((id: number) => {
    deleteLinksStatement.run(id);
    const result = deleteSpendStatement.run(id);
    if (result.changes !== 1) {
      throw new Error(`cannot delete spend ${id}: not found`);
    }
  });

  const insertManyTransaction = db.transaction(
    (drafts: SpendDraft[], rawText: string): Spend[] => {
      const createdAt = new Date().toISOString();
      return drafts.map((draft) => {
        const result = insertStatement.run({
          amount: draft.amount,
          description: draft.description,
          tags: JSON.stringify(draft.tags),
          rawText,
          createdAt,
        });
        return {
          id: Number(result.lastInsertRowid),
          ...draft,
          rawText,
          createdAt,
        };
      });
    },
  );

  return {
    insert(draft: SpendDraft, rawText: string): Spend {
      const spends = insertManyTransaction([draft], rawText);
      const spend = spends[0];
      if (!spend) {
        throw new Error("insert transaction returned no spend");
      }
      return spend;
    },

    insertMany(drafts: SpendDraft[], rawText: string): Spend[] {
      return insertManyTransaction(drafts, rawText);
    },

    update(id: number, draft: SpendDraft, rawText: string): Spend {
      const result = updateStatement.run({
        id,
        amount: draft.amount,
        description: draft.description,
        tags: JSON.stringify(draft.tags),
        rawText,
      });
      if (result.changes !== 1) {
        throw new Error(`cannot update spend ${id}: not found`);
      }
      const row = selectByIdStatement.get(id) as SpendRow;
      return toSpend(row);
    },

    delete(id: number): void {
      deleteTransaction(id);
    },

    linkMessage(spendId: number, telegramMessageId: number): void {
      linkMessageStatement.run(telegramMessageId, spendId);
    },

    findByMessageId(telegramMessageId: number): Spend | undefined {
      const row = selectByMessageIdStatement.get(telegramMessageId) as
        | SpendRow
        | undefined;
      return row ? toSpend(row) : undefined;
    },

    listRecent(limit: number): Spend[] {
      const rows = listStatement.all(limit) as SpendRow[];
      return rows.map(toSpend);
    },

    close(): void {
      db.close();
    },
  };
}

function toSpend(row: SpendRow): Spend {
  return {
    id: row.id,
    amount: row.amount,
    description: row.description,
    tags: JSON.parse(row.tags) as Tag[],
    rawText: row.raw_text,
    createdAt: row.created_at,
  };
}
