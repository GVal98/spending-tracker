import Database from "better-sqlite3";
import type { SpendDraft } from "./parse.js";
import type { Tag } from "./tags.js";

export interface Spend extends SpendDraft {
  id: number;
  rawText: string;
  createdAt: string; // ISO 8601 UTC
}

/**
 * One numbered line of a bot confirmation message. `spend` is null once the
 * spend was deleted: positions stay stable so the numbers in the message
 * keep meaning the same thing.
 */
export interface MessageItem {
  position: number;
  spend: Spend | null;
}

export interface SpendStore {
  insert(draft: SpendDraft, rawText: string): Spend;
  /** Inserts all drafts in one transaction — a receipt is saved fully or not at all. */
  insertMany(drafts: SpendDraft[], rawText: string): Spend[];
  /** Full replacement of amount/description/tags; createdAt is preserved. */
  update(id: number, draft: SpendDraft, rawText: string): Spend;
  /** Removes the spend; its message positions remain and resolve to null. Throws if the id is unknown. */
  delete(id: number): void;
  /**
   * Associates a bot confirmation message with the spends it lists, in
   * message order (position 1 = first line). Replaces any previous links of
   * that message.
   */
  linkMessage(telegramMessageId: number, spendIds: readonly number[]): void;
  /** Items of a confirmation message by position; empty when the message is not ours. */
  findByMessageId(telegramMessageId: number): MessageItem[];
  listRecent(limit: number): Spend[];
  /** Spends with fromIso <= created_at < toIso (ISO UTC strings compare lexicographically). */
  listBetween(fromIso: string, toIso: string): Spend[];
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
  `);
  migrateSpendMessages(db);

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
    `SELECT m.position, s.id, s.amount, s.description, s.tags, s.raw_text, s.created_at
     FROM spend_messages m LEFT JOIN spends s ON s.id = m.spend_id
     WHERE m.telegram_message_id = ?
     ORDER BY m.position`,
  );
  const listStatement = db.prepare(
    `SELECT id, amount, description, tags, raw_text, created_at
     FROM spends ORDER BY id DESC LIMIT ?`,
  );
  const listBetweenStatement = db.prepare(
    `SELECT id, amount, description, tags, raw_text, created_at
     FROM spends WHERE created_at >= ? AND created_at < ? ORDER BY id`,
  );
  const insertLinkStatement = db.prepare(
    `INSERT INTO spend_messages (telegram_message_id, position, spend_id)
     VALUES (?, ?, ?)`,
  );
  const deleteMessageLinksStatement = db.prepare(
    `DELETE FROM spend_messages WHERE telegram_message_id = ?`,
  );
  const deleteSpendStatement = db.prepare(`DELETE FROM spends WHERE id = ?`);
  const unlinkSpendStatement = db.prepare(
    `UPDATE spend_messages SET spend_id = NULL WHERE spend_id = ?`,
  );

  const deleteTransaction = db.transaction((id: number) => {
    unlinkSpendStatement.run(id);
    const result = deleteSpendStatement.run(id);
    if (result.changes !== 1) {
      throw new Error(`cannot delete spend ${id}: not found`);
    }
  });

  const linkMessageTransaction = db.transaction(
    (telegramMessageId: number, spendIds: readonly number[]) => {
      deleteMessageLinksStatement.run(telegramMessageId);
      spendIds.forEach((spendId, index) => {
        insertLinkStatement.run(telegramMessageId, index + 1, spendId);
      });
    },
  );

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

    linkMessage(telegramMessageId: number, spendIds: readonly number[]): void {
      if (spendIds.length === 0) {
        throw new Error(`cannot link message ${telegramMessageId} to zero spends`);
      }
      linkMessageTransaction(telegramMessageId, spendIds);
    },

    findByMessageId(telegramMessageId: number): MessageItem[] {
      const rows = selectByMessageIdStatement.all(telegramMessageId) as MessageItemRow[];
      return rows.map((row) => ({
        position: row.position,
        spend: row.id === null ? null : toSpend(row as SpendRow),
      }));
    },

    listRecent(limit: number): Spend[] {
      const rows = listStatement.all(limit) as SpendRow[];
      return rows.map(toSpend);
    },

    listBetween(fromIso: string, toIso: string): Spend[] {
      const rows = listBetweenStatement.all(fromIso, toIso) as SpendRow[];
      return rows.map(toSpend);
    },

    close(): void {
      db.close();
    },
  };
}

/**
 * spend_messages v2: one row per numbered line of a confirmation message.
 * v1 (single spend per message, spend_id NOT NULL, links deleted with the
 * spend) is rewritten in place as position 1. Runs once; a v2 table is
 * detected by its `position` column.
 */
function migrateSpendMessages(db: Database.Database): void {
  const columns = db.pragma("table_info(spend_messages)") as { name: string }[];
  const isV1 = columns.length > 0 && !columns.some((column) => column.name === "position");
  db.transaction(() => {
    if (isV1) {
      db.exec("ALTER TABLE spend_messages RENAME TO spend_messages_v1");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS spend_messages (
        telegram_message_id INTEGER NOT NULL,
        position            INTEGER NOT NULL, -- 1-based line number in the message
        spend_id            INTEGER REFERENCES spends(id), -- NULL once the spend is deleted
        PRIMARY KEY (telegram_message_id, position)
      );
    `);
    if (isV1) {
      db.exec(`
        INSERT INTO spend_messages (telegram_message_id, position, spend_id)
        SELECT telegram_message_id, 1, spend_id FROM spend_messages_v1;
        DROP TABLE spend_messages_v1;
      `);
    }
  })();
}

interface MessageItemRow {
  position: number;
  id: number | null;
  amount: number | null;
  description: string | null;
  tags: string | null;
  raw_text: string | null;
  created_at: string | null;
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
