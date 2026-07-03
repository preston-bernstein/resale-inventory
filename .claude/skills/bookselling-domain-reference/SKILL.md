---
name: bookselling-domain-reference
description: Used-book domain theory as implemented in this repo. Use when asking "what is an ISBN", ISBN-10 vs ISBN-13, check digits, normalizeISBN, condition grading (Poor/Acceptable/Good/Very Good/Like New), listing lifecycle, "Sale Pending", "held inventory", "why cents" / money-as-integer, gross profit, CSV formula injection, import leniency, or the Open Library lookup API. Explains WHY the domain works this way; not for exact constant values or bug fixing.
---

# Bookselling Domain Reference

Domain knowledge pack for the book-seller repo (`/Users/prestonbernstein/dev/book-seller`): a local-first inventory app for a **sole used-book seller** on secondary markets (e.g., Amazon). This skill explains what the domain concepts *mean* and how this repo implements them. Spec ground truth lives in `docs/book-inventory-management/requirements.md` (FR = functional requirement, AC = acceptance criterion) and `docs/book-inventory-management/plan.md`.

**When NOT to use this skill** — see the section at the bottom. Short version: exact constant values → `book-seller-config-and-constants`; fixing bugs → `book-seller-debugging-playbook`; system invariants → `book-seller-architecture-contract`.

---

## 1. ISBN

### 1.1 What an ISBN is

An **ISBN** (International Standard Book Number) uniquely identifies a *specific edition* of a book — hardcover and paperback of the same title have different ISBNs. Two formats exist:

| | ISBN-10 | ISBN-13 |
|---|---|---|
| Era | pre-2007 standard | 2007+ standard (all new books) |
| Structure | 9 data digits + 1 check digit | `978`/`979` EAN prefix + 9 data digits + 1 check digit |
| Check digit alphabet | `0`-`9` or `X` (X = 10) | `0`-`9` only |
| Check algorithm | weighted sum, mod 11 | alternating 1/3 weights, mod 10 |
| Relationship | every ISBN-10 maps to exactly one `978…` ISBN-13 (same 9 data digits, recomputed check digit) | `979…` ISBN-13s have **no** ISBN-10 equivalent |

**EAN** (European/International Article Number) is the 13-digit retail barcode standard; ISBN-13 is simply an EAN in the "Bookland" `978`/`979` prefix range. That is why ISBN-13 uses the EAN check-digit algorithm.

This repo canonicalizes everything to **ISBN-13** at the door: `normalizeISBN()` in `lib/isbn.ts` converts ISBN-10 input, and the DB stores one string column `isbn` with a partial unique index (`idx_books_isbn ... WHERE isbn IS NOT NULL` in `data/migrations/001_init.sql`).

### 1.2 ISBN-10 check digit (mod 11) — worked example

Weights 10 down to 1; the sum must be divisible by 11. Example `0-306-40615-2` (the repo's own test fixture in `lib/__tests__/isbn.test.ts`):

| digit | 0 | 3 | 0 | 6 | 4 | 0 | 6 | 1 | 5 | 2 |
|---|---|---|---|---|---|---|---|---|---|---|
| weight | 10 | 9 | 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1 |
| product | 0 | 27 | 0 | 42 | 24 | 0 | 24 | 3 | 10 | 2 |

Sum = 132; 132 mod 11 = 0 → **valid**. When the required check value is 10, it is written as `X` — hence the ISBN-10 alphabet `\d{9}[\dX]`.

### 1.3 ISBN-13 / EAN check digit (mod 10) — worked example

Weights alternate 1, 3, 1, 3, … over the first 12 digits; check digit = `(10 − sum mod 10) mod 10`. Continuing the same book, base = `978` + `030640615`:

| digit | 9 | 7 | 8 | 0 | 3 | 0 | 6 | 4 | 0 | 6 | 1 | 5 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| weight | 1 | 3 | 1 | 3 | 1 | 3 | 1 | 3 | 1 | 3 | 1 | 3 |
| product | 9 | 21 | 8 | 0 | 3 | 0 | 6 | 12 | 0 | 18 | 1 | 15 |

Sum = 93; check digit = (10 − 3) mod 10 = **7** → `9780306406157`. So `0-306-40615-2` → `9780306406157`, exactly what the test suite asserts. Second fixture from the tests: `019853453X` → `9780198534532` (the `X` check digit is simply dropped in conversion).

### 1.4 How `normalizeISBN()` implements this

`lib/isbn.ts` `normalizeISBN(isbn: string)`:

1. Strip hyphens and spaces (`replace(/[-\s]/g, '')`).
2. If 13 digits → return as-is (**passthrough — no check-digit validation**).
3. If it matches ISBN-10 shape (`/^\d{9}[\dX]$/`) → take the first 9 digits, **dropping the ISBN-10 check digit without validating it**, prepend `978`, compute the EAN-13 check digit (1/3 weights, mod 10), append.
4. Anything else → `throw new Error('Invalid ISBN format.')`.

The shared shape pattern is `ISBN_PATTERN = /^\d{9}[\dX]$|^\d{13}$/`, duplicated in `lib/isbn.ts` and `app/api/isbn/[isbn]/route.ts` (exact constant homes → `book-seller-config-and-constants`).

**KNOWN LIMITATION 1 — ISBN-10 check digit never verified.** A mistyped ISBN-10 whose check digit is wrong (e.g., `0306406153` instead of `...2`) is *silently accepted* and converted to a well-formed ISBN-13 for the wrong-or-nonexistent book. The mod-11 step in §1.2 exists in the standard precisely to catch such typos; this code skips it.

**KNOWN LIMITATION 2 — ISBN-13 check digit never verified.** A 13-digit input only has to match `\d{13}`; `9780306406150` (bad check digit) passes straight through. Both limitations mean the Open Library lookup returning 404 is often the *first* signal of a typo. Do not "fix" these on your own — behavior change → `book-seller-change-control`.

### 1.5 Why `isbn` is nullable

Real used-book inventory includes pre-ISBN publications (ISBN adoption began ~1970), books with damaged/missing barcodes, and small-press items. FR3 requires manual entry for exactly these; the `books.isbn` column is nullable and the unique index applies only `WHERE isbn IS NOT NULL`. An empty ISBN is a normal state, not an error.

---

## 2. Condition grading

Used-book marketplaces price and rank listings by condition grade. This repo uses a fixed 5-grade ladder (FR5). Marketplace meanings below are **general used-book trade convention** (aligned with Amazon-style guidelines), not defined anywhere in this repo — the repo only defines the labels:

| Grade | Trade meaning (convention) |
|---|---|
| **Like New** | Looks unread/barely opened; dust jacket intact; no marks. Top price tier. |
| **Very Good** | Light wear; no writing or highlighting; all pages intact. |
| **Good** | Average used copy; may have owner's name, limited notes/highlighting, worn cover. The workhorse grade. |
| **Acceptable** | Heavily worn but complete and readable; may have significant markings, loose jacket. Lowest sellable grade on most platforms. |
| **Poor** | Below marketplace minimums; typically not listable — candidates for Donated/Discarded. |

Why a **fixed enum**: condition drives search filters (FR13), dashboard counts (FR14), and CSV import validation. Free text would fragment those ("VG", "very good", "Very Good+"). Enforcement lives in the DB `CHECK (condition IN ('Poor','Acceptable','Good','Very Good','Like New'))` in `data/migrations/001_init.sql`, and the list is duplicated in at least three TypeScript sites (e.g., `VALID_CONDITIONS` in `app/api/import/route.ts`, `ALL_CONDITIONS` in `app/api/dashboard/route.ts`, plus API route/UI copies — `grep -rln "Like New" app lib components data/migrations` hits 9 files, verified 2026-07-02). Adding a grade therefore touches the migration *and* every TS copy; extension rules and the duplication invariant → `book-seller-architecture-contract`; exact homes → `book-seller-config-and-constants`.

---

## 3. Listing lifecycle

### 3.1 The state machine

Defined in `lib/transitions.ts` (`ALLOWED_TRANSITIONS` + `assertTransitionAllowed`) and FR10; also enforced structurally by DB CHECKs (Listed/Sale Pending require `listing_price`; Sold requires `sale_price`, `sale_date`, `sale_platform`).

| Status | Commercial meaning | May transition to |
|---|---|---|
| **Unlisted** | Owned, on the shelf, not offered for sale anywhere. Default at creation and import. | Listed, Donated, Discarded |
| **Listed** | Actively offered on ≥1 platform at `listing_price`. | Unlisted, Sale Pending, Removed, Donated, Discarded |
| **Sale Pending** | A buyer has committed but the sale isn't final (payment clearing, offer accepted, awaiting pickup). Book must be pulled from other platforms mentally — it's spoken for. | Listed, Sold |
| **Sold** | Sale completed; `sale_price`/`sale_platform`/`sale_date` recorded. **Terminal.** | — |
| **Removed** | Delisted permanently without a sale (e.g., platform takedown, kept for personal use). **Terminal.** | — |
| **Donated** | Given away; capital written off. **Terminal.** | — |
| **Discarded** | Trashed/recycled; capital written off. **Terminal.** | — |

### 3.2 Why Sale Pending exists

Marketplace sales are not atomic: between "buyer clicked buy" and "money settled" the book must neither be double-sold nor counted as freely sellable. FR11 defines the two exits: **confirm → Sold**, **fall-through → Listed**. It is the only non-terminal state a book can leave in two commercially opposite directions.

### 3.3 Why terminal states never reopen

Audit integrity. Once Sold, the record *is* the P&L history — the requirements constraint says acquisition cost and sale price must not be editable after Sold. Allowing Sold → Listed would let historical profit silently change. If a sale is refunded/returned, the domain answer is a correction workflow (not modeled here), never reopening the row. Same logic for Removed/Donated/Discarded: they are dispositions, and FR9/AC4 require the system to reject e.g. Sold → Listed with a clear error.

**OPEN — owner decision required:** `lib/transitions.ts` does **not** allow Listed → Sold directly (you must pass through Sale Pending), but requirements AC3 describes an item going from Listed straight to Sold when a sale is recorded. `docs/book-inventory-management/challenge-notes.md` § "Open questions requiring human input" tracks this contradiction. Do not resolve it unilaterally — route to `book-seller-change-control`.

### 3.4 Held inventory — what the dashboard numbers mean

**Held** (FR15) = status IN (**Unlisted, Listed, Sale Pending**). Commercially: capital still at risk — cash converted into paper that has not yet converted back. Sold/Removed/Donated/Discarded books are resolved and excluded.

`app/api/dashboard/route.ts` implements this literally: `HELD_STATUSES = ['Unlisted', 'Listed', 'Sale Pending']`; `held_count` = COUNT of those rows; `held_acquisition_cost` = SUM(`acquisition_cost`) over them, **in integer cents**. To the business: `held_acquisition_cost` is "how much money is currently sitting on my shelves"; a rising number with flat sales means over-buying. `by_condition` and `by_status` counts (same route) cover **all** books including terminal ones — only the two `held_*` figures are filtered.

---

## 4. Money

### 4.1 Why integer cents

IEEE-754 binary floats cannot represent most decimal fractions exactly:

```js
0.1 + 0.2 === 0.3   // false — actual value 0.30000000000000004
```

Sum thousands of prices as floats and the error accumulates into visible off-by-a-cent P&L. So this repo stores **every monetary value as integer cents** (`acquisition_cost`, `listing_price`, `sale_price` are `INTEGER` columns) and converts at the edges only, per the NFR "no floating-point accumulation errors" and plan Risk 2 ("a single missed conversion silently corrupts data" — all conversions centralized in `lib/money.ts`).

### 4.2 The conversion rules (`lib/money.ts`)

- `usdToCents("9.99") → 999`. Uses **string arithmetic** — splits on the decimal point and parses digit groups; the float never touches the math. Rejects non-numeric, negative, and anything over **100,000,000 cents ($1,000,000)**.
- Rounding: **half-up on the third fractional digit**. The fraction is padded/truncated to 3 digits; first 2 → cents, third ≥ 5 → +1 cent. From the test suite (`lib/__tests__/money.test.ts`): `"1.005" → 101` and `"0.004" → 0`. Algorithm-traced example (from reading `lib/money.ts`, not a test fixture): `"9.999" → 1000` (rounds *up* to $10.00, not truncated to 999).
- `centsToUSD(150) → "1.50"` — display formatting, two decimals, done with integer div/mod, not division-then-`toFixed`.
- Currency symbols are rejected (`"$9.99"` throws) — CSV cells must be bare decimals.

### 4.3 Gross profit

**Gross profit = `sale_price − acquisition_cost`**, in cents, defined only for Sold items (FR12). Two properties matter:

1. **Computed at read time in SQL, never stored.** See `app/api/export/route.ts`: `CASE WHEN b.status = 'Sold' THEN (b.sale_price - b.acquisition_cost) ELSE NULL END AS gross_profit_cents`. There is no `gross_profit` column. A stored copy once diverged from its inputs via a truncation incident — details in `book-seller-failure-archaeology`. Derive, don't persist.
2. **It is *gross*.** Platform fees, shipping, and tax are explicitly out of scope (requirements § "Out of scope"). A book bought for $2.00 and sold for $10.00 shows $8.00 gross profit even if Amazon fees ate $3.50 of it. Never present this number as net margin.

---

## 5. CSV interchange

### 5.1 Formula injection — the threat and the defense

Spreadsheet apps (Excel, LibreOffice, Sheets) treat any cell starting with `=`, `+`, `-`, or `@` as a **formula and execute it** on open. A malicious or accidental book title like `=CMD|'/c calc'!A1` in an exported CSV becomes code execution on the operator's machine. Since titles/authors come from an external API and free-text entry, export must assume hostile cell content.

Defense in `app/api/export/route.ts`:

```ts
function sanitize(value: string): string {
  if (value && /^[=+\-@]/.test(value)) return '\t' + value;
  return value;
}
```

Every cell starting with a formula trigger gets a **tab prefix**, which forces spreadsheets to treat it as text while keeping the value visually intact. Applied to *all* cells uniformly.

### 5.2 Import: lenient on packaging, strict on substance

Plan Risk 3: spreadsheet apps add BOMs, reformat dates/currency, and rename headers on re-export. `app/api/import/route.ts` therefore:

- **Lenient**: strips a UTF-8 BOM from header keys, trims whitespace on keys and values, skips empty lines, ignores unknown columns, and *silently ignores* sale-related columns (`sale_price_usd`, `sale_platform`, `sale_date`, `status`) — every imported book starts life as `Unlisted`.
- **Strict**: five required columns — `title`, `author`, `condition`, `acquisition_cost_usd`, `acquisition_date` (FR21); condition must match the enum exactly; date must be `YYYY-MM-DD`; cost must parse via `usdToCents`. For these validation classes, per-row errors report the exact row number and field names and the batch continues (FR22, AC9) — bad rows are skipped, good rows land. **CAVEAT (live Defect D2, verified 2026-07-02): duplicate ISBNs are NOT caught per-row** — a duplicate anywhere in the file (or vs the DB) currently aborts the entire import with HTTP 500 and zero rows land, violating FR22's intent. History: `book-seller-failure-archaeology` D2; fix: `book-seller-constraint-leak-campaign`.

Why this split: the operator round-trips CSVs through Excel; packaging noise is inevitable and must not block imports, but a wrong condition or garbled price is a data-integrity problem the operator must see and fix by row.

### 5.3 Spreadsheet re-export hazards

Even with a clean export, opening the CSV in a spreadsheet and re-saving can corrupt it: dates get locale-reformatted (`2026-07-02` → `7/2/26`, which fails the import's `YYYY-MM-DD` check), currency columns gain `$` signs (rejected by `usdToCents`), long ISBNs become scientific notation (`9.78031E+12`), and leading zeros vanish. The import validator will *catch* these (that's the point of strictness), but expect a wall of per-row errors after a careless Excel round-trip. Advise editing CSVs in a text editor or forcing text-format columns.

---

## 6. ISBN lookup provider: Open Library Books API

### 6.1 API shape

`lib/isbn.ts` `lookupISBN()` calls, free with no API key:

```
GET https://openlibrary.org/api/books?bibkeys=ISBN:<isbn>&format=json&jscmd=data
```

Response is keyed by the request's bibkey (sketch, matching the shape mocked in `lib/__tests__/isbn.test.ts`):

```json
{
  "ISBN:9780306406157": {
    "title": "On Being a Scientist",
    "authors":    [{ "name": "Committee on Science" }],
    "publishers": [{ "name": "National Academies Press" }]
  }
}
```

The code extracts `title`, `authors[0].name`, `publishers[0].name` → `{ title, author, publisher }`. Note the lookup keys the response with the **raw stripped input** (`ISBN:<stripped>`), not the normalized ISBN-13 — an ISBN-10 query expects the response keyed `ISBN:0306406152`. An unknown ISBN returns `{}` (HTTP 200), i.e., "not found" is the *absence of the key*, not an error status.

### 6.2 Failure modes and guards

| Failure | Guard in `lib/isbn.ts` | Result |
|---|---|---|
| Bad ISBN shape | `ISBN_PATTERN` test before building the URL (also SSRF/path-injection hygiene) | `null`, no network call |
| Slow API | 3s `AbortController` timeout (NFR: lookup completes or times out ≤ 3s) | `null` |
| Oversized response | body streamed and capped at 64 KB | `null` |
| Network/parse error, non-OK status, missing key | try/catch + explicit checks | `null` |

`app/api/isbn/[isbn]/route.ts` maps these to HTTP: pattern failure → 400; `null` or an empty title+author → 404; success → 200 JSON.

### 6.3 Degraded mode is a first-class path, not an error path

Plan Risk 1: Open Library has thin coverage for **academic texts, self-published books, pre-1970 titles, and international editions** — common in real used-book sourcing. So lookup failure is an expected daily event, and the design answer (FR3, AC11) is: every error collapses to `null`/404, the form stays editable, and the operator types title/author/publisher by hand. Nothing about a failed lookup may ever block item creation. When reasoning about "the API is down" scenarios: the app is *designed* to work fully without it.

---

## 7. Glossary

Domain terms used across the book-seller skill library (infrastructure terms like WAL are deliberately excluded — see `book-seller-build-and-env` / `book-seller-run-and-operate` for those):

| Term | Definition in this repo's context |
|---|---|
| **ISBN** | International Standard Book Number; edition-level book identifier. Stored as canonical ISBN-13 string; nullable (§1.5). |
| **EAN** | The 13-digit retail barcode standard; ISBN-13 is an EAN with prefix 978/979, hence the shared mod-10 check algorithm. |
| **Condition grade** | One of the fixed 5 values Poor → Like New describing physical state; drives pricing and filters (§2). |
| **Listing** | An offer of a specific book at `listing_price` on one or more platforms. A book can be listed on several platforms at once (FR19, `book_platforms` junction table). |
| **Delisting** | Withdrawing a listing: Listed → Unlisted (temporary, still held) or Listed → Removed (permanent, terminal). |
| **Sale pending** | Buyer committed, sale not final; only state with two opposite exits — Sold (confirm) or Listed (fall-through) (§3.2). |
| **Comp** | "Comparable" — a recently sold copy of the same edition/condition used to judge price. Sellers' vocabulary; **not modeled in this repo** (pricing/valuation is out of scope per requirements). |
| **Acquisition cost** | What the operator paid for the book, integer cents, required at creation; immutable after Sold. |
| **Gross profit** | `sale_price − acquisition_cost`, cents, Sold items only, SQL-derived at read time, excludes fees/shipping/tax (§4.3). |
| **Held** | Status in {Unlisted, Listed, Sale Pending}; capital still at risk; the population behind dashboard `held_count` / `held_acquisition_cost` (§3.4). |
| **Sale platform** | The single platform where the sale actually closed (`sale_platform` column, FR20) — distinct from the listing platforms in `book_platforms`. |
| **Terminal state** | Sold, Removed, Donated, Discarded — no outbound transitions, ever (§3.3). |

---

## 8. When NOT to use this skill

| You need… | Go to |
|---|---|
| Exact constant values / where a constant lives (limits, patterns, enum copies) | `book-seller-config-and-constants` |
| System invariants, extension costs (e.g., adding a condition grade), duplication contracts | `book-seller-architecture-contract` |
| To fix a bug or diagnose failing behavior | `book-seller-debugging-playbook`, `book-seller-diagnostics-and-tooling` |
| Details of past incidents (e.g., the gross-profit truncation) | `book-seller-failure-archaeology` |
| To change behavior this skill documents (e.g., resolve the AC3 contradiction, validate check digits) | `book-seller-change-control` |
| Build, env vars, running the app, ports | `book-seller-build-and-env`, `book-seller-run-and-operate` |
| Test strategy / QA process | `book-seller-validation-and-qa` |
| Writing docs or specs | `book-seller-docs-and-writing` |

This skill is theory + rationale. It intentionally does not duplicate constant tables, runbooks, or incident timelines.

---

## Provenance and maintenance

Authored 2026-07-02 against the uncommitted working tree (repo has zero git commits). All code claims verified by reading: `lib/isbn.ts`, `lib/money.ts`, `lib/transitions.ts`, `lib/db.ts`, `data/migrations/001_init.sql`, `app/api/export/route.ts`, `app/api/import/route.ts`, `app/api/isbn/[isbn]/route.ts`, `app/api/dashboard/route.ts`, `lib/__tests__/isbn.test.ts`, `lib/__tests__/money.test.ts`, `docs/book-inventory-management/requirements.md`, `plan.md`, `challenge-notes.md`. Trade-convention grade meanings (§2) and comp definition (§7) are general domain knowledge, not repo artifacts. The gross-profit truncation incident is cited from task context; details live in `book-seller-failure-archaeology` (ASSUMPTION: not independently re-verified here).

Re-verification one-liners (all read-only; **never** run `npx vitest run` — it wipes the real DB; never write to `data/inventory.db`):

- ISBN normalization + gaps: `grep -n "ISBN_PATTERN\|978\|checkDigit" lib/isbn.ts` (confirm no mod-11 validation before `slice(0, 9)`).
- Condition enum sites: `grep -rn "Like New" app lib components data/migrations`
- Transition table: `cat lib/transitions.ts` (confirm no `Listed → Sold`; cross-check requirements AC3 + challenge-notes open question).
- Held statuses: `grep -n "HELD_STATUSES" app/api/dashboard/route.ts`
- Money rounding/bounds: `grep -n "roundDigit\|100_000_000" lib/money.ts`
- Gross profit derived-not-stored: `grep -rn "gross_profit" app data/migrations` (must appear in SELECTs only, never as a column).
- CSV injection defense: `grep -n "sanitize" app/api/export/route.ts`
- Import required fields / leniency: `grep -n "REQUIRED_FIELDS\|IGNORED_FIELDS\|normalizedKey" app/api/import/route.ts`
- DB reads, if needed: `sqlite3 "file:data/inventory.db?mode=ro" ".schema books"`
