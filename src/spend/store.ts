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
    )
  `);

  const insertStatement = db.prepare(
    `INSERT INTO spends (amount, description, tags, raw_text, created_at)
     VALUES (@amount, @description, @tags, @rawText, @createdAt)`,
  );
  const listStatement = db.prepare(
    `SELECT id, amount, description, tags, raw_text, created_at
     FROM spends ORDER BY id DESC LIMIT ?`,
  );

  return {
    insert(draft: SpendDraft, rawText: string): Spend {
      const createdAt = new Date().toISOString();
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
