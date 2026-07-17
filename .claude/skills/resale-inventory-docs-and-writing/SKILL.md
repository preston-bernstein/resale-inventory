---
name: resale-inventory-docs-and-writing
description: Where resale-inventory's (formerly resale-inventory) documentation lives, which file wins, the house writing style, and copy-paste templates for new feature specs, task trackers, and review notes. Use when asked to "write a spec", "create new feature docs", "update requirements", "edit TASKS.md", "document a decision", "fix the README", or when unsure where a piece of documentation belongs or how to phrase an FR/AC.
---

# Book-Seller — Docs and Writing

## Docs of record

> ASSUMPTION (coordinator-approved): `docs/<slug>/` spec folders are the change-control authority. Gates and precedence live in `resale-inventory-change-control` — this skill covers the files themselves and how to write them.

There are now **two** spec folders — the pattern below applies to both, and a future feature gets its own new `docs/<slug>/`:

- `docs/book-inventory-management/` — the original books-only spec (22 FRs, 11 ACs, `TASKS.md` 17/17 done 2026-07-01). Still the authority for book-category data/behavior; `docs/multi-category-inventory/requirements.md` explicitly keeps it "in force unchanged."
- `docs/multi-category-inventory/` — the later books+clothing migration spec (`TASKS.md` generated 2026-07-11). Authority for the category-agnostic `items` schema, the `app/api/books/**`→`app/api/items/**` and `app/books/**`→`app/inventory/**` route consolidation, and clothing-specific behavior.

| File | Role | Authority rank | Edit policy |
|---|---|---|---|
| `docs/<slug>/requirements.md` | WHAT the system does: FRs, NFRs, constraints, out-of-scope, ACs | 1 (highest) | Edit first for any behavior change; numbered items are referenced by ID everywhere — never renumber, only append |
| `docs/<slug>/plan.md` | HOW: architecture, schema, API contract, tech choices, risks, security | 2 | Update after requirements, before code |
| `docs/<slug>/steps.md` | Planned implementation sequence | 3 | Historical once built; new work gets new steps or a new folder |
| `docs/<slug>/TASKS.md` | Execution record | 3 | Append/update task statuses; keep the legend |
| `docs/<slug>/challenge-notes.md` | Adversarial spec-review record | record | **Append-only** — it is evidence, not living spec |
| `docs/<slug>/*.bak` | Frozen pre-review originals of requirements/plan/steps | historical | **NEVER edit.** Their only use: diff against current to see what the review changed (`resale-inventory-failure-archaeology` does this) |
| `docs/<slug>/.ctx.md` | Generated context snapshot | generated | Regenerate, don't hand-edit |
| `README.md` | Real project README (rewritten from the original create-next-app boilerplate) — describes the multi-category feature set, stack, and links to `docs/SELLER-PLAYBOOK.md`/`docs/PHONE-ACCESS.md` | — | Keep in sync with shipped features; docs-only change (lightest gate) |
| `docs/SELLER-PLAYBOOK.md`, `docs/PHONE-ACCESS.md`, `docs/clothing-resale-research.md`, `docs/reseller-architecture-research.md`, `docs/research-*.md` | Operator-facing / research reference docs outside the spec-folder pattern (playbook content, phone/Tailscale access notes, sourcing and architecture research, dated frontier-item investigation notes) | reference, not spec authority | Not gated by section 1's precedence order — these document the domain/product, not the change-control contract. Edit directly; no FR/AC numbering |
| `.claude/skills/*/SKILL.md` | This skill library | operational | Rules below |

New features get their own folder: `docs/<slug>/` with the same four-file shape.

## House style (derived from the real files, 2026-07-02)

**Functional requirements** — numbered, "The system shall", one testable behavior each:

> "9. The system shall prevent status transitions that are logically invalid (e.g., Sold → Listed) and return a clear error."

Lesson encoded in FR9→FR10 history: "prevent invalid X" with one example is untestable; the review forced full enumeration (FR10 lists every legal transition). Write the enumeration, not the vibe.

**Acceptance criteria** — numbered, Given/When/Then prose:

> "4. Given an attempt to set an item from Sold back to Listed, the system rejects the transition and returns an error; the item remains Sold."

**Unresolved externals** — square-bracket placeholders, kept visible until decided:

> "[secondary market platform(s)]", "ISBN lookup provider is [provider TBD]"

**plan.md section order** (keep it): Approach → Architecture (ASCII diagram) → Data model (full SQL) → API / interface contract (per-route request/response/errors) → Integration points (file-by-file) → Technology choices (each with why) → Risk areas (numbered, concrete) → Security (concrete mitigations).

**TASKS.md conventions**:

```
## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked
```

Per task: `**Status**/**Files**/**Test**/**Depends on**/**Parallelizable**/**Notes**`. Header line: `Generated from: docs/<slug>/ on <date>`. Keep the trailing `## Blocked / open` section.

**Exactness rules for any doc in this repo**:
- Quote API error strings verbatim, including the arrow character: `Transition Sold → Listed is not permitted.` (source: `lib/transitions.ts`).
- Money columns: `_usd` suffix = decimal string ("12.50"); bare names (`acquisition_cost`, `listing_price`) = integer cents. Never mix within a table without labeling.
- Dates ISO-8601 (`YYYY-MM-DD`).
- FR/AC/risk references by number (FR22, AC9, Risk 6) — they are stable IDs.

## Templates

### docs/<slug>/requirements.md

```markdown
# Requirements: <Feature Name>

## Problem statement
<Who hurts, how, and what record/ability this feature establishes.>

## Users / stakeholders
- **<role>** — <relationship to feature>

## Functional requirements
1. The system shall <one testable behavior>.

## Non-functional requirements
- <latency / durability / precision bounds>

## Constraints
- <hard boundaries; use [bracketed placeholders] for undecided externals>

## Out of scope
- <explicit exclusions — this section prevents scope archaeology later>

## Acceptance criteria
1. Given <state>, when <action>, the system <observable outcome>.
```

### docs/<slug>/plan.md

```markdown
# Plan: <Feature Name>

## Approach
<One paragraph: the shape of the solution and why it fits the constraints.>

## Architecture
<ASCII diagram of pages/routes/data flow>

## Data model
<Full SQL, including CHECK constraints and indexes>

## API / interface contract
**<METHOD> <path>**
```
Request  { ... }
Response <code> { ... }
Errors   <code> { error: "<exact string>" }
```

## Integration points
- `<file>` — <one line>

## Technology choices
- **<tech>** — <why here, not in general>

## Risk areas
1. **<risk>** — <concrete failure mode + mitigation>

## Security
- <concrete, checkable mitigations>
```

### docs/<slug>/TASKS.md — copy the legend + per-task shape above verbatim.

### docs/<slug>/challenge-notes.md

```markdown
# Spec Challenge Notes: <Feature Name>

## Agents run
- <reviewer> : <N issues found, M accepted>

## Changes made
- **<change>**: <what and why>

## Critiques rejected
- <finding> — <why rejected>

## Open questions requiring human input
- **<question>**: <options + what blocks on it>
```

The "Open questions" section is load-bearing: the AC3 contradiction lives in one (SR-6 in `resale-inventory-failure-archaeology`) and is still governing behavior. Never delete an open question — resolve it with a dated answer or carry it.

## Skill-library maintenance rules

- One skill = one directory under `.claude/skills/` with `SKILL.md` (YAML frontmatter: `name`, trigger-rich `description`) plus optional `scripts/`, `fixtures/`.
- **One home per fact.** Constants → config-and-constants; failures → failure-archaeology; invariants → architecture-contract. Other skills cross-reference by skill name, never restate.
- Every skill ends with `## Provenance and maintenance`: authored/verified date + one-line re-verification commands for volatile facts. Editing a skill = re-dating its provenance.
- New failure knowledge is APPENDED to `resale-inventory-failure-archaeology` (it has the entry template), then linked.
- Descriptions must say when to load the skill (trigger phrases) and when not — models route on descriptions alone.

## When NOT to use this skill

- What gate a change needs / whether spec must move first → `resale-inventory-change-control`.
- Recording a defect or investigation → `resale-inventory-failure-archaeology` (its own template).
- Writing tests → `resale-inventory-validation-and-qa`.
- The content of the domain (what to SAY in a spec about ISBNs, money, statuses) → `bookselling-domain-reference`.

## Provenance and maintenance

Authored 2026-07-02, content-refreshed 2026-07-12. Style rules derived by reading every file in both `docs/book-inventory-management/` and `docs/multi-category-inventory/` (including .bak originals), README.md, `lib/transitions.ts` (exact error string), `app/api/export/route.ts` (`_usd` convention).

Re-verify:
- Docs inventory: `ls docs/book-inventory-management/ docs/multi-category-inventory/ docs/*.md`
- README reflects current features (no longer boilerplate): `head -5 README.md` (expect a real project description, not create-next-app default text — flag it as a gap again if it ever reverts)
- Error string: `grep -n "is not permitted" lib/transitions.ts`
- TASKS legend intact: `grep -n "Status legend" -A 5 docs/multi-category-inventory/TASKS.md`
- Skill inventory: `ls .claude/skills/`
