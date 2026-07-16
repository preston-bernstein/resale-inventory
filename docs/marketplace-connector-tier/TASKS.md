# Tasks: Marketplace Connector Tier

Generated from: docs/marketplace-connector-tier/ on 2026-07-16

## Status legend
- [ ] pending
- [>] in progress
- [x] done
- [!] blocked

## Tasks

### Task 1: Define shared connector types and error classes
**Status**: [x] done
**Files**: lib/connectors/types.ts
**Test**: `npm run build && npm test -- lib/connectors/__tests__/types.test.ts`
**Depends on**: none
**Parallelizable**: no
**Notes**:

### Task 2: Add SupportedPlatform type export and pacing constants
**Status**: [x] done
**Files**: lib/constants.ts
**Test**: `npm run build`; assert pacing constant values
**Depends on**: Task 1
**Parallelizable**: no
**Notes**:

### Task 3: Create item_platforms and poshmark_pacing migrations; update VERSIONED_MIGRATIONS
**Status**: [x] done
**Files**: data/migrations/009_item_platforms_external_id.sql, data/migrations/010_poshmark_pacing.sql, lib/db.ts
**Test**: migrations appear in lib/db.ts with version 9/10; sqlite3 schema check
**Depends on**: Task 1
**Parallelizable**: no
**Notes**:

### Task 4: Implement centralized item_platforms upsert
**Status**: [x] done
**Files**: lib/connectors/itemPlatformsWrite.ts
**Test**: unit test for upsert behavior + tenant_id scoping
**Depends on**: Task 2, Task 3
**Parallelizable**: no
**Notes**:

### Task 5: Implement environment variable validation for app-level credentials
**Status**: [x] done
**Files**: lib/connectors/envConfig.ts
**Test**: requireEnv throws ConnectorNotConfiguredError when unset (eBay + Etsy), succeeds when set
**Depends on**: Task 1, Task 2
**Parallelizable**: no
**Notes**:

### Task 6: Implement shared OAuth token refresh logic for API-tier connectors
**Status**: [x] done
**Files**: lib/connectors/apiCredential.ts
**Test**: mocked getDecryptedCredential/rotateCredential test + short-TTL cache test
**Depends on**: Task 1, Task 2, Task 5
**Parallelizable**: no
**Notes**:

### Task 7: Implement gating wrapper, centralized createListing success hook, and automationGate.ts
**Status**: [x] done
**Notes**: lib/automationGate.ts already existed (shipped in the multi-tenant foundation PR #8) — verified, not recreated.
**Files**: lib/connectors/gate.ts, lib/automationGate.ts
**Test**: mocked assertCanAutomate returns not-ok, asserts ConnectorGatingError thrown before raw method invoked
**Depends on**: Task 1, Task 2, Task 4
**Parallelizable**: no
**Notes**:

### Task 8: Implement shared credential-scrubbing utility
**Status**: [x] done
**Files**: lib/connectors/scrub.ts
**Test**: seeded secret string stripped from output
**Depends on**: Task 1
**Parallelizable**: yes
**Notes**:

### Task 9: Implement pacing/rate-limiting wrapper for Depop/Mercari/Vinted/Grailed
**Status**: [x] done
**Files**: lib/connectors/pacing.ts
**Test**: rate-limit window behavior test
**Depends on**: Task 1, Task 2
**Parallelizable**: no
**Notes**:

### Task 10: Implement Playwright session persistence/dry-run/read-only health validation; add Playwright dependency
**Status**: [x] done
**Files**: lib/connectors/playwrightSession.ts, package.json, next.config.ts
**Test**: dry-run no browser context test; validateSessionReadOnly never logs in; mock playwright module; npm install/build succeed
**Depends on**: Task 1, Task 2
**Parallelizable**: no
**Notes**:

### Task 11a: Implement eBay OAuth token exchange and API client setup
**Status**: [x] done
**Files**: lib/connectors/ebay.ts (partial), lib/connectors/apiFetch.ts
**Test**: unit test for token exchange param formatting
**Depends on**: Task 1, Task 2, Task 5, Task 6, Task 7
**Parallelizable**: no
**Notes**:

### Task 11b: Implement eBay raw methods with mocked HTTP
**Status**: [x] done
**Files**: lib/connectors/ebay.ts, lib/connectors/__tests__/ebay.test.ts
**Test**: `npm test -- lib/connectors/__tests__/ebay.test.ts`
**Depends on**: Task 11a
**Parallelizable**: no
**Notes**:

### Task 11c: Implement eBay Sandbox integration test harness (skip-gated)
**Status**: [x] done
**Files**: lib/connectors/__tests__/ebay.sandbox.test.ts
**Test**: `npm test -- lib/connectors/__tests__/ebay.sandbox.test.ts` skips when no sandbox creds
**Depends on**: Task 11b
**Parallelizable**: no
**Notes**:

### Task 12: Implement Etsy Open API v3 connector with PKCE and draft-only listings
**Status**: [x] done
**Files**: lib/connectors/etsy.ts, lib/connectors/__tests__/etsy.test.ts
**Test**: `npm test -- lib/connectors/__tests__/etsy.test.ts`; assert state always draft
**Depends on**: Task 1, Task 2, Task 5, Task 6, Task 7
**Parallelizable**: yes
**Notes**:

### Task 13: Implement Amazon SP-API connector (inert-by-default)
**Status**: [x] done
**Files**: lib/connectors/amazon.ts, lib/connectors/__tests__/amazon.test.ts
**Test**: `npm test -- lib/connectors/__tests__/amazon.test.ts`; AmazonNotConfiguredError from all 5 methods
**Depends on**: Task 1, Task 2, Task 5, Task 7
**Parallelizable**: yes
**Notes**:

### Task 14a: Implement Poshmark durable cooldown and share-cap persistence logic
**Status**: [x] done
**Files**: lib/connectors/poshmark.ts (partial)
**Test**: unit tests for cooldown/share-cap SQL logic + sharePoshmarkListing gating
**Depends on**: Task 1, Task 2, Task 3, Task 7
**Parallelizable**: no
**Notes**:

### Task 14b: Implement Poshmark Playwright action layer
**Status**: [x] done
**Files**: lib/connectors/poshmark.ts, lib/connectors/__tests__/poshmark.test.ts
**Test**: `npm test -- lib/connectors/__tests__/poshmark.test.ts`; cooldown/cap/dry-run/health assertions
**Depends on**: Task 14a, Task 10
**Parallelizable**: no
**Notes**:

### Task 15: Implement Depop connector
**Status**: [x] done
**Files**: lib/connectors/depop.ts, lib/connectors/__tests__/depop.test.ts
**Test**: `npm test -- lib/connectors/__tests__/depop.test.ts`
**Depends on**: Task 1, Task 7, Task 9, Task 10
**Parallelizable**: yes
**Notes**:

### Task 16: Implement Mercari connector
**Status**: [x] done
**Files**: lib/connectors/mercari.ts, lib/connectors/__tests__/mercari.test.ts
**Test**: `npm test -- lib/connectors/__tests__/mercari.test.ts`
**Depends on**: Task 1, Task 7, Task 9, Task 10
**Parallelizable**: yes
**Notes**:

### Task 17: Implement Vinted connector
**Status**: [x] done
**Files**: lib/connectors/vinted.ts, lib/connectors/__tests__/vinted.test.ts
**Test**: `npm test -- lib/connectors/__tests__/vinted.test.ts`
**Depends on**: Task 1, Task 7, Task 9, Task 10
**Parallelizable**: yes
**Notes**:

### Task 18: Implement Grailed connector
**Status**: [x] done
**Files**: lib/connectors/grailed.ts, lib/connectors/__tests__/grailed.test.ts
**Test**: `npm test -- lib/connectors/__tests__/grailed.test.ts`
**Depends on**: Task 1, Task 7, Task 9, Task 10
**Parallelizable**: yes
**Notes**:

### Task 19: Implement connector registry factory
**Status**: [x] done
**Files**: lib/connectors/registry.ts
**Test**: getConnector('ebay') returns eBay connector; getConnector('invalid') throws
**Depends on**: Task 1, Task 2, Task 7, Task 11c, Task 12, Task 13, Task 14b, Task 15, Task 16, Task 17, Task 18
**Parallelizable**: no
**Notes**:

### Task 20: Write comprehensive gating integration tests
**Status**: [x] done
**Notes**: written as part of Task 7 (gate.ts implementation) per its own Test field.
**Files**: lib/connectors/__tests__/gate.test.ts
**Test**: `npm test -- lib/connectors/__tests__/gate.test.ts` (mock-based, not real connectors)
**Depends on**: Task 1, Task 4, Task 5, Task 7
**Parallelizable**: yes
**Notes**:

### Task 21: Write comprehensive itemPlatformsWrite integration tests
**Status**: [x] done
**Notes**: written as part of Task 4 (itemPlatformsWrite.ts implementation) per its own Test field.
**Files**: lib/connectors/__tests__/itemPlatformsWrite.test.ts
**Test**: `npm test -- lib/connectors/__tests__/itemPlatformsWrite.test.ts`
**Depends on**: Task 1, Task 2, Task 3, Task 4
**Parallelizable**: yes
**Notes**:

### Task 22: Write comprehensive registry integration tests
**Status**: [x] done
**Notes**: written as part of Task 19 (registry.ts implementation) per its own Test field.
**Files**: lib/connectors/__tests__/registry.test.ts
**Test**: `npm test -- lib/connectors/__tests__/registry.test.ts`
**Depends on**: Task 19
**Parallelizable**: yes
**Notes**:

### Task 23a: Write suspension signal detection tests (API-tier)
**Status**: [x] done
**Notes**: written per-connector as part of Tasks 11b/12/13.
**Files**: lib/connectors/__tests__/ebay.test.ts, lib/connectors/__tests__/etsy.test.ts, lib/connectors/__tests__/amazon.test.ts
**Test**: `npm test -- lib/connectors/__tests__/{ebay,etsy,amazon}.test.ts`
**Depends on**: Task 1, Task 11c, Task 12, Task 13
**Parallelizable**: yes
**Notes**:

### Task 23b: Write suspension signal detection tests (browser-tier)
**Status**: [x] done
**Notes**: written per-connector as part of Tasks 14b/15/16/17/18.
**Files**: lib/connectors/__tests__/poshmark.test.ts, lib/connectors/__tests__/depop.test.ts, lib/connectors/__tests__/mercari.test.ts, lib/connectors/__tests__/vinted.test.ts, lib/connectors/__tests__/grailed.test.ts
**Test**: `npm test -- lib/connectors/__tests__/{poshmark,depop,mercari,vinted,grailed}.test.ts`
**Depends on**: Task 1, Task 14b, Task 15, Task 16, Task 17, Task 18
**Parallelizable**: yes
**Notes**:

### Task 24: Verify npm test passes without any platform credentials configured
**Status**: [x] done
**Notes**: `npm test` — 1258 passed, 22 skipped, 0 failed. `npm run build` succeeds. `tsc --noEmit` clean. `eslint` — 0 errors, 35 pre-existing warnings unrelated to this feature. Fixed two real bugs found only when running the full suite together (not per-file): (1) itemPlatformsWrite.test.ts and poshmark.test.ts's cleanup queries were missing `item_photos`/`price_history`/`book_details`/`clothing_details` deletes before `DELETE FROM items`, causing FK violations against state left by other test files sharing the scratch DB; (2) tests/api/tenant-isolation.test.ts hardcoded an expectation of `user_version` reaching 8 — updated to 10 now that migrations 009/010 exist.

### Task 25: Create .env.example and update README.md
**Status**: [x] done
**Files**: .env.example, README.md, .gitignore
**Test**: file content checks per steps.md
**Depends on**: Task 11c, Task 12, Task 13, Task 14b
**Parallelizable**: no
**Notes**:

## Blocked / open
(populated during implementation)
