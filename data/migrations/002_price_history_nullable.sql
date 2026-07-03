-- 002_price_history_nullable.sql
-- DR-7: price_history.previous_price / new_price were declared INTEGER NOT NULL,
-- so the route coalesced a missing prior/new price to 0 ('?? 0'), making the
-- audit trail unable to distinguish "was free/zero" from "was unset". SQLite
-- cannot alter an inline column constraint in place, so this rebuilds the table
-- (book-seller-change-control §4, plan.md Risk 7) with both price columns
-- nullable. NULL now means "no prior price" (previous_price) / "price cleared"
-- (new_price); a real 0 means "explicitly zero/free".
--
-- Existing rows are copied AS-IS. Rows already written with the 0 sentinel are
-- unrecoverable (failure-archaeology DR-7) and are deliberately NOT backfilled —
-- we cannot tell which 0s meant "unset" vs "genuinely zero". Only NEW writes
-- get the NULL fix.
--
-- Applied exactly once, guarded by PRAGMA user_version in lib/db.ts (version 2),
-- and run inside a JS transaction there. Nothing references price_history, so
-- the drop/rename is FK-safe with foreign_keys=ON.

CREATE TABLE price_history_new (
  id             TEXT    PRIMARY KEY,            -- UUIDv4
  book_id        TEXT    NOT NULL REFERENCES books(id),
  previous_price INTEGER,                        -- cents; NULL = no prior price
  new_price      INTEGER,                        -- cents; NULL = price cleared
  changed_at     TEXT    NOT NULL                -- ISO-8601 datetime
);

INSERT INTO price_history_new (id, book_id, previous_price, new_price, changed_at)
  SELECT id, book_id, previous_price, new_price, changed_at FROM price_history;

DROP TABLE price_history;

ALTER TABLE price_history_new RENAME TO price_history;

CREATE INDEX IF NOT EXISTS idx_ph_book ON price_history(book_id);
