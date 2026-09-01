# Spend Tracker Telegram Bot — Plan

Single-user Telegram bot: send a free-text message describing a spend, an LLM
parses it into a structured record with tags, the bot saves it and confirms.

## Stack

| Concern      | Choice                          | Why                                                                                     |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| Language     | Node.js + TypeScript            | Requested                                                                                |
| Telegram lib | grammY                          | TypeScript-first, great docs, built-in long polling                                      |
| Server       | None (long polling)             | No HTTP server, no public URL needed; webhook is a small isolated change later           |
| Database     | SQLite via `better-sqlite3`     | Single file, zero setup, sync API, real SQL for future stats                             |
| ORM          | None (raw SQL)                  | One table; minimize deps, abstract late                                                  |
| LLM access   | OpenRouter, plain `fetch`       | One POST endpoint; thin client module doubles as a test seam                             |
| LLM model    | `google/gemini-3.7-flash`       | Requested; configurable via env                                                          |

## MVP scope

1. **Add spend**: user texts e.g. `coffee with Anna 6.50` →
   LLM (with the hardcoded tag list in the prompt) returns structured JSON:
   amount, description, matching tags → saved to SQLite → bot replies with a
   confirmation (amount, description, tags) so parse errors are immediately visible.
2. **`/list`**: show the last N spends (amount, description, tags, date) —
   minimal way to verify data without opening the DB file.
3. **Tags**: hardcoded list in code (e.g. `food`, `transport`, `fun`, ...).
   Multiple tags per spend.
4. **Access control**: only the owner's Telegram user ID is accepted;
   everyone else gets a polite refusal.
5. **Failure handling**: LLM parse failure → clear "couldn't parse" reply,
   nothing saved. Config (bot token, OpenRouter key, model, owner user ID)
   loaded from `.env` and validated at startup — fail fast on missing config.
6. **Tests**: domain logic only (parse-result validation, tag matching).
   Telegram/DB edges stay thin and untested in MVP.

### Data model

```sql
CREATE TABLE spends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  amount     REAL    NOT NULL,
  description TEXT   NOT NULL,
  tags       TEXT    NOT NULL,  -- JSON array of tag names
  raw_text   TEXT    NOT NULL,  -- original user message
  created_at TEXT    NOT NULL   -- ISO 8601 UTC
);
```

### Project structure (feature-based)

```
src/
  config.ts        # env loading + validation, fail fast
  bot.ts           # Telegram adapter (grammY), wiring only
  spend/
    tags.ts        # hardcoded tag list
    parse.ts       # parse contract + LLM-output validation (pure)
    store.ts       # SQLite persistence
  llm/
    openrouter.ts  # thin fetch client for chat completions
```

## Iteration 2 (done)

- **Edit / delete via reply-to-message**: replying to a bot confirmation
  (“Saved:” / “Updated:”) with `delete`/`del`/`remove` deletes that spend;
  replying with a correction (e.g. “actually 7.50”) sends the existing spend +
  correction to the LLM and fully replaces amount/description/tags.
  Confirmation messages are linked to spends in `spend_messages`
  (`telegram_message_id PK, spend_id`), including new “Updated:” confirmations,
  so any of them works as a reply target. `created_at` is preserved on edit.

## Iteration 3 (done)

- **Photo spends, itemized**: send a receipt photo (caption optional) → the
  image goes to the same Gemini model as a base64 data URL (multimodal chat
  completion). The model returns one entry **per receipt line item**
  (`{"spends": [...]}`, no grand-total entry); each item is saved as its own
  spend with its own tags, inserted in one SQLite transaction (all-or-nothing —
  one invalid entry rejects the whole response, capped at 100 items). Each item
  gets its own confirmation message so it stays individually editable/deletable
  by reply; multi-item saves are prefixed with an item-count + total summary
  message. Caption is included and takes precedence over the photo. The photo
  itself is not stored; `raw_text` records `[photo]` plus the caption for every
  item. Bytes are re-uploaded rather than passing Telegram's file URL to
  OpenRouter (that URL embeds the bot token); 10MB size cap.
- **Multi-spend text messages**: text goes through the same list pipeline with
  the same `{"spends": [...]}` contract — “coffee 5 and taxi 12” yields two
  spends, each with its own tags and confirmation message. Edit-by-reply stays
  single-spend (a correction targets one spend).

## Later (explicitly out of MVP)

- **/stats** — totals per tag for week/month
- **Audio** — voice message → transcription → same parse pipeline
- **Dynamic tags** — manage tags via bot commands instead of hardcode
- **Multi-currency** — MVP assumes one implicit currency
- **CSV export**
- **Webhook deployment** — for serverless/production hosting
- **Multi-user support**

## Security notes

- Secrets live in `.env` (gitignored); `.env.example` documents required vars.
- The OpenRouter key used during development was shared in chat — rotate it
  before any real use.
