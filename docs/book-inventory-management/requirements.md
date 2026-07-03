# Requirements: Book Inventory Management

## Problem statement

A used-book seller operating across secondary markets (e.g., Amazon) manages a large physical collection with no structured system. Without it, stock levels are unknown until a sale fails, pricing decisions are made from memory, and revenue is scattered across platform reports. This feature establishes the authoritative inventory record — every book the owner holds, what it cost, what it is listed for, and what happened to it — so that sourcing, pricing, and fulfillment decisions are grounded in data rather than guesswork.

## Users / stakeholders

- **Owner / operator** — the sole user; sources books, sets prices, fulfills orders, tracks P&L.
- **[Secondary market platforms]** — downstream consumers of listing data; source of inbound sale events.

## Functional requirements

1. The system shall allow the operator to add a book to inventory by entering ISBN, title, author, condition, acquisition cost, and acquisition date.
2. The system shall auto-populate title, author, and publisher from ISBN lookup so that the operator does not manually transcribe bibliographic data.
3. The system shall accept manual entry for books that cannot be resolved by ISBN (no ISBN, damaged barcode, pre-ISBN publication).
4. The system shall assign each inventory item a unique internal identifier at creation time.
5. The system shall record condition using a fixed vocabulary: Poor, Acceptable, Good, Very Good, Like New.
6. The system shall allow the operator to record the current listing price and the platform(s) on which the book is listed.
7. The system shall track listing status for each item: Unlisted, Listed, Sale Pending, Sold, Removed, Donated, Discarded.
8. The system shall transition an item's status to Sold and record sale price, platform, and sale date when the operator records a completed sale.
9. The system shall prevent status transitions that are logically invalid (e.g., Sold → Listed) and return a clear error.
10. The system shall enforce the following and only the following status transitions: Unlisted → Listed, Unlisted → Donated, Unlisted → Discarded; Listed → Unlisted, Listed → Sale Pending, Listed → Removed, Listed → Donated, Listed → Discarded; Sale Pending → Listed, Sale Pending → Sold; Sold, Removed, Donated, and Discarded are terminal states (no further transitions permitted).
11. The system shall allow the operator to mark an item as Sale Pending to indicate a sale is in progress but not yet confirmed. An item in Sale Pending status may transition to Sold (confirming the sale) or back to Listed (if the sale falls through).
12. The system shall calculate gross profit per item as (sale price − acquisition cost) when an item reaches Sold status.
13. The system shall allow the operator to search inventory by ISBN (exact match), title (case-insensitive substring match), author (case-insensitive substring match), condition (exact match), or status (exact match); all filters are optional and combinable.
14. The system shall display a summary dashboard showing: total items held, total acquisition cost of held inventory, count by condition, count by listing status.
15. For purposes of FR14 and AC8, "held" means an item whose status is one of Unlisted, Listed, or Sale Pending. Items with status Sold, Removed, Donated, or Discarded are not held.
16. The system shall allow the operator to update listing price, platform, or condition for any item whose status is Unlisted, Listed, or Sale Pending.
17. The system shall record a history entry whenever listing price is changed, capturing the previous price, the new price, and the timestamp of the change.
18. The system shall allow the operator to export the full inventory to CSV with all fields intact.
19. The system shall allow an item to be listed on one or more platforms simultaneously; the operator may record multiple platform names for a single item.
20. The system shall record the platform on which a sale occurred as a separate field from the listing platform(s).
21. The import schema shall use the same column names as the CSV export (FR18), with the following fields required: title, author, condition, acquisition_cost_usd, acquisition_date. All other fields are optional and ignored if present.
22. The system shall allow bulk import of inventory items from a CSV file conforming to the import schema defined in FR21, and report per-row errors without aborting the entire batch. A row whose ISBN duplicates another row already in inventory, or another row earlier in the same file, is one such per-row error; the row is skipped and all remaining valid rows are still committed.
23. The system shall require a listing_price to be set on an item before it can transition to Listed or Sale Pending status. An attempt to make this transition without a listing_price is rejected with a validation error identifying the missing field; no partial state change occurs.
24. The system shall reject an attempt to clear (set to null) an item's listing_price while the item is in Listed or Sale Pending status, with a validation error explaining that the item must first transition out of those statuses. This does not affect clearing listing_price on items in Unlisted, Sold, Removed, Donated, or Discarded status.

## Non-functional requirements

- Data must be persisted to durable local or hosted storage; no data loss on application restart.
- ISBN lookup must complete or time out within 3 seconds; on timeout the form must remain editable for manual entry.
- Export must complete within 10 seconds.
- All monetary values stored and displayed to two decimal places in USD; no floating-point accumulation errors in profit calculations.

## Constraints

- Single-user system; no concurrent write contention requirement.
- Must integrate with [secondary market platform(s)] sale event flow — either via manual operator entry or an import mechanism; direct API integration is not mandated in this feature.
- Acquisition cost and sale price fields must not be editable after an item reaches Sold status (audit integrity).
- ISBN lookup provider is [provider TBD]; the system must function in degraded mode (manual entry only) if the provider is unavailable.

## Out of scope

- Automated listing creation or price updates pushed to [secondary market platform(s)].
- Automated ingestion of sale events from platform APIs.
- Multi-user access or role-based permissions.
- Shipping cost tracking or fulfillment workflow.
- Tax calculations or accounting-system integration.
- Book valuation / market price recommendations (a separate pricing feature).
- Physical location or shelf tracking within storage.
- Image capture or storage for individual books.

## Acceptance criteria

1. Given a valid ISBN, when the operator submits it, the system populates title, author, and publisher without manual entry and creates an inventory record with status Unlisted.
2. Given an unresolvable ISBN or a book with no ISBN, the operator can complete item creation using only manual fields; the record is saved successfully.
3. Given an item in Listed status, when the operator records a sale with price and platform, the item transitions to Sold and gross profit is computed correctly as (sale price − acquisition cost).
4. Given an attempt to set an item from Sold back to Listed, the system rejects the transition and returns an error; the item remains Sold.
5. Given a price change on a Listed item, the system stores the new price and retains the previous price with a change timestamp; querying price history returns both values.
6. Given a search by partial title, the system returns all inventory items whose title contains the search string, regardless of case.
7. Given a search by condition "Very Good", the system returns only items in Very Good condition.
8. Given 100 items in inventory, the dashboard correctly displays total acquisition cost equal to the sum of all individual acquisition costs for held items (items with status Sold, Removed, Donated, or Discarded are excluded from held totals).
9. Given a valid CSV import file with 50 rows, 48 valid and 2 with missing required fields, the system imports the 48 valid rows, reports exactly 2 errors with row numbers and field names, and makes no changes for the 2 invalid rows.
10. Given a full inventory export, every field defined in the data model appears as a column, all Sold items include sale price and sale date, and the file opens correctly in a standard spreadsheet application.
11. Given an ISBN lookup provider outage, the operator can still create a new inventory item via manual entry; no error blocks form submission.
12. Given a CSV import file where one row's ISBN duplicates another row already in inventory and a second row's ISBN duplicates an earlier row in the same file, the system imports all other valid rows, reports one per-row error for each duplicate naming its row number, and makes no partial changes for either duplicate row.
13. Given an Unlisted item with no listing_price, when the operator attempts to transition it to Listed, the system rejects the transition with a validation error naming listing_price, and the item remains Unlisted. Given the operator then sets a listing_price and retries, the transition succeeds.
