# Roadmap status: credentials in progress, fonts reconfirmed, LICENSE deferred

**Date:** 2026-10-26T12:50:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** M5 (Phase 0 gates); §4.10 Documentation

---

## WHAT CHANGED

A documentation-only change to `docs/ROADMAP.md` and `docs/SUPER_ADMIN_BUILD_SHEET.md`. **No code, migration or test changed.**

- **Gates G0-1 and G0-2** (migrations 004-021 on a hosted Supabase project and `cloud:check`; a Razorpay test-mode run) are marked **in progress**:
  Aman is setting up the hosted project and the test-mode credentials. Neither run has happened, and the docs say so. The roadmap's §4.9a Phase 0
  row and the M5 bullet changed with them.
- **LICENSE** is marked deferred to a later task in §4.10 and in the M3 list. Nothing is blocked on it.
- **Fonts and icons reconfirmed** (Aman, 2026-10-26): Cabinet Grotesk + Instrument Sans and the repo's `lucide-react` (^0.475). This was already decided on
  2026-10-25; the roadmap and the build sheet now record the reconfirmation.
- The "last reconciled" line carries the new date.

## CHECKED

A search of the repo outside `docs/` and `Darshil_docs/` found no Fraunces, DM Sans or Lucide 0.263 reference. The design-system tokens
(`design-system/css/tokens.css`, `design-system/ts/tokens.ts`) use Cabinet Grotesk and Instrument Sans. The only remaining mentions of the old fonts are
the two "superseded" notes. The hub's fallback server page and the files under `misc/demos/` use system fonts; they were left as they are.

## NOT DONE

G0-1 and G0-2 themselves; decisions D1-D5; the GST audit (G0-3) and the ledger analysis (G0-4); the LICENSE; everything in the super admin plan.

Status: ✅ the docs match the decisions made; 🟡 hosted Supabase and Razorpay test mode are being set up; ⬜ LICENSE (later).
