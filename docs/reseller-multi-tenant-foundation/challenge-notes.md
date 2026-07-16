# Spec Challenge Notes

## Agents run
- Requirements Auditor (haiku): 13 issues found, 12 accepted
- Scope & Dependency Auditor (sonnet): 8 issues found, 4 accepted
- Design Devil's Advocate (sonnet): 12 issues found, 6 accepted
- Implementation Realist (sonnet): 5 major findings (with sub-points) found, 5 accepted
- Steps & Sequencing Critic (sonnet): ~15 issues found, 15 accepted
- Data Model Critic (sonnet): 17 issues found, 9 accepted
- Security/Threat Auditor (haiku): 17 issues found, 6 accepted

## Changes made

- **Fixed a real cross-tenant data leak**: `lib/dashboard.ts`'s `getDashboardData()` took zero parameters and was named as an integration point but never actually appeared in any step's file list — as originally specced, every tenant would have seen every other tenant's dashboard stats. Now has its own explicit step (signature change to `getDashboardData(tenantId)`, threaded through all 5 internal queries).
- **Fixed a feature-breaking auth conflict**: the blanket `requireTenant()` retrofit would have 401'd the already-shipped phone-handoff feature, since the paired phone authenticates via a bearer token in the URL and never holds a session cookie. Carved out `app/api/phone-session/[token]/route.ts` and the `X-Pairing-Token` upload path to resolve tenant scope via the pairing token instead.
- **Fixed a circular dependency**: steps 13–15 (route retrofits) required the `createTestTenant()` test fixture from what was step 16, which itself depended on "steps 1–15" — unbuildable as specced. Moved fixture creation to right after session-issuance, before any route retrofit.
- **Closed a one-way door**: `connection_status = 'revoked'` was permanent with no acknowledged path back — once a marketplace revoked a tenant's connection, that tenant could never reconnect through the app. Added a fresh-reconnect path (delete + re-create with new consent) for `revoked` specifically; `suspended` still requires explicit reactivation only.
- **Fixed a test-pollution bug matching a documented past incident in this exact codebase**: the credential-encryption master-key fallback file resolved to the real repo root, not a scratch path — unlike `BOOKSELLER_DB_PATH`, which this codebase already overrides specifically because tests polluting real on-disk state was "discovered the hard way" before. Added the same scratch-path override pattern.
- **Hardened the data model** with 8 cheap, pre-any-rows fixes: `email` case-insensitive uniqueness, a partial unique index so "the current consent row" is unambiguous, a length CHECK on encrypted credentials, a satellite-table `tenant_id`-consistency trigger (mirrors the existing `items_category_immutable` precedent), and a `connection_status`→`status` rename for naming consistency with `items.status`/`phone_pairing_tokens.status`.
- **Added a minimal functional login/signup page**: the original spec built only API routes with no page to call them from, which would have made the live, deployed app unusable through the browser (every page would 401 with no way to authenticate). Added plain, unstyled forms — explicitly not a UI/UX design task.
- **Added missing auth hardening NFRs**: password strength floor, rate limiting on signup/login (scrypt is deliberately CPU-expensive, making an unthrottled endpoint a self-inflicted DoS vector), OWASP-baseline KDF cost parameters, and a cookie-flag test requirement — none of these existed in the original spec despite this being the app's first real authentication surface.

## Critiques rejected

- **argon2/bcrypt over scrypt** (Design Devil's Advocate): rejected to preserve this app's stated zero-new-dependency value; addressed the real underlying risk (weak parameters) instead by adding an explicit OWASP-minimum cost-parameter NFR.
- **`platforms` DB lookup table instead of app-layer allowlist** (Design Devil's Advocate): rejected as scope expansion — already a documented, deliberate tradeoff in the plan's Risk section, and doesn't fix an actual bug.
- **4th `connection_status` value (`pending_reauth`) added preemptively** (Data Model Critic): rejected as speculative/YAGNI — the 3-state enum matches current requirements; extension cost is already acknowledged.
- **`tenant_consents.disclosure_version` FK-to-non-PK-column rename** (Data Model Critic): rejected — the design is deliberate (integer version comparison is simpler than joining through UUIDs for the hot consent-check path).
- **Default-tenant-ID hardcoded/predictable** (Security Auditor): rejected — low incremental risk given the unclaimed password already gates login, and the app isn't publicly exposed.
- **Kill-switch signal-source spoofing/HMAC validation** (Security Auditor): rejected for this increment — explicitly deferred to connector-tier specs per the original requirements' own scope boundary; captured below as an open question instead.
- **SQL-injection/prepared-statement audit across all 12 retrofitted routes** (Security Auditor): rejected as a spec change — redundant with FR9 and this codebase's existing parameterized-query convention via `better-sqlite3`.
- **Full self-serve tenant-management dashboard UI** (Scope & Dependency Auditor): rejected — a minimal login/signup page was accepted, but a full connection-management dashboard remains correctly out of scope.
- **Operator/tenant admin capabilities** (Scope & Dependency Auditor): rejected as new scope for this increment; captured below as an open question.
- **Password-reset / tenant-offboarding / GDPR deletion flows** (Design Devil's Advocate, Scope Auditor): rejected — explicitly out of scope per the original requirements and the owner's foundation-only framing.

## Open questions requiring human input

1. **ISBN cross-tenant leak, deliberately deferred**: `book_details.isbn` has a pre-existing global (non-tenant-scoped) UNIQUE constraint. After this increment, a tenant can still learn "this ISBN exists somewhere" via a 409 vs 201 response — a weak but real cross-tenant signal. Fixing it properly requires a table-rebuild migration disproportionate to this "additive foundation" increment's scope, so it's documented and deferred rather than fixed. Flag if this should be prioritized sooner given the app is moving toward real multi-tenant use.
2. **Operator vs. tenant administrative capabilities are completely undefined** — fine for a single-operator deployment today, but will need a real answer before onboarding a second real tenant (can an operator list/suspend other tenants? is the operator just tenant #1 with no special powers?).
3. **Kill-switch signal-source authentication** (verifying a suspension signal actually came from the platform, not a spoofed call) is explicitly deferred to the connector-tier specs per this increment's scope — flagging so it isn't forgotten when those specs get written.
4. **Production deploy has a real lockout risk**: the default tenant's `password_hash='unclaimed'` placeholder requires a manual one-time SQL claim step immediately post-deploy, or the operator (Preston) will be locked out of the browser UI for his own live inventory on the desktop deployment. This is documented as a pre-ship checklist item in plan.md's Risk areas, but it's a real operational step that must actually happen at deploy time, not just be written down.
