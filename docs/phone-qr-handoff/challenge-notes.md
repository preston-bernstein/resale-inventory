# Spec Challenge Notes

## Agents run
- Requirements Auditor (sonnet): 15 issues found, 12 accepted
- Scope & Dependency Auditor (sonnet): 10 issues found, 6 accepted (folded into requirements/plan fixes above; 4 rejected)
- Design Devil's Advocate (sonnet): 8 issues found, 6 accepted, 2 rejected
- Implementation Realist (sonnet): 17 issues found, 9 accepted, 8 already covered by existing plan text (no change needed)
- Steps & Sequencing Critic (sonnet): 12 issues found, 10 accepted, 2 rejected
- Data Model Critic (sonnet): 12 issues found, 11 accepted, 1 rejected (redundant index, already folded into fix)
- Security/Threat Auditor (sonnet): 13 issues found, 7 accepted, 6 rejected

## Changes made
- **Tailnet-origin spoofing fix (plan.md)**: origin detection no longer just blocklists `localhost`/IP literals — it now allowlists the actual Tailscale MagicDNS suffix (or an explicit `PUBLIC_ORIGIN` override), closing a gap where a spoofed `Host` header could produce a QR code pointing the phone at an attacker-controlled origin. The single most serious finding across all seven agents.
- **Timestamp storage switched to epoch-ms integers (plan.md)**: three independent agents flagged the same bug class — `phone_pairing_tokens.created_at`/`expires_at`/`first_accessed_at` were labeled "ISO-8601 UTC" but SQLite's `datetime('now')` isn't actually ISO-8601, risking silent early/late token expiry from JS/SQLite string-format mismatches. Switched to Unix epoch milliseconds (INTEGER) to eliminate the bug class outright.
- **Data model hardening (plan.md)**: added `ON DELETE CASCADE` on the token→item FK (item deletion would otherwise hard-fail once a phone session ever existed for that item), added missing CHECK constraints (expiry ordering, first-access window, token-hash length), removed a redundant index, added the composite/expiry indexes actually needed by the poll and hygiene-delete queries, and wrapped the "end prior token, insert new" sequence in one transaction to close a double-click race.
- **Resolved requirements.md's self-contradictions**: FR17 (navigate-away) and AC9 (origin-undetermined) each had two-branched, unresolved language. Both now state the single decided behavior directly, and all `[threshold TBD]` placeholders got concrete values (15 min TTL, 1s issuance, 5s photo-appear).
- **Closed the "token feels single-use" wording bug**: FR10's "already-consumed" language implied the token invalidates itself on first phone-view open, which contradicts the actual multi-use-within-TTL design. Reworded throughout.
- **Added missing security/UX requirements**: server-side re-validation of the clothing-only category on token issuance (not just a client-side button hide), a no-logging-raw-token requirement, upload success/failure feedback on the phone view, an explicit component error state, a manual-URL fallback next to the QR, and test-writing expectations added to every step's Test field (repo enforces 85/80/85/85 coverage).
- **Fixed two real dependency-graph gaps in steps.md**: Steps 8 and 10 were missing a dependency on Step 6 (the token-gated upload extension) — without it, their own tests could pass green even if token validation on uploads was never built.

## Critiques rejected
- Adding per-operation ownership/nonce gating to `GET`/`DELETE /api/items/[id]/phone-session` (Security Auditor) — rejected as inconsistent with this app's existing whole-network trust model: there is no login system anywhere in this app by design, so gating just these two endpoints wouldn't reduce real exposure and would introduce a bespoke session concept the Constraints explicitly forbid.
- Rate-limiting the token-resolution/upload endpoints (Security Auditor) — rejected; 256-bit token entropy already makes brute-force infeasible, and the threat model is single-user/LAN-only. Documented as an explicit accepted-risk NFR instead of building throttling infrastructure.
- Treating the CSRF Origin-check no-op for headerless (curl-style) requests as a gap in the token path (Security Auditor) — rejected; the pairing token itself functions as a bearer credential for that specific request, which is the intended and sufficient control, not a CSRF bypass.
- Splitting the extended photos route into two separate handlers to avoid "commingled trust models" (Design Devil's Advocate) — rejected as over-engineering for a 5–10 line additive header check; addressed instead with a lighter recommendation to extract only the shared category-check logic.
- Building multi-item/batch phone-capture sessions (Design Devil's Advocate) — explicitly out of scope, added as a stated out-of-scope bullet rather than a design change.

## Open questions requiring human input
None — all findings were either resolved with a concrete decision or explicitly documented as an accepted trade-off in requirements.md/plan.md. Ready for `/new-story`.
