# The super admin console: the plan goes into the roadmap

**Date:** 2026-10-25T10:00:00+05:30
**Branch:** `feat/m2-kitchen-ops`
**Milestone:** §4.9 Deployment & fleet; new M5

---

## WHAT CHANGED

A documentation-only change. Aman and Darshil's build sheet (`SUPER_ADMIN_BUILD_SHEET.md`, drafted 2026-10-24) is now in `docs/` as the plan of record, and the
roadmap carries it: §4.9a (invariants I1-I10, the shape, the phase table for phases 0-7, alerting, the decision register D1-D8, the never-build list) and a
new milestone M5 with its definition of done. The "still open on the console" bullet points at it. **No code, migration or test changed, and nothing in the plan is built.**

## DECIDED IN THIS CHANGE

Aman, 2026-10-25: the console keeps the product's **Cabinet Grotesk + Instrument Sans** and the repo's **`lucide-react`** (^0.475). The sheet's earlier
"Fraunces + DM Sans, Lucide v0.263.1" is superseded; the sheet and the roadmap both now say so.

## CHECKED AGAINST THE REPO (read-only, before writing it down)

- The next free migration is 022 (the last is `021_ops_console.sql`), as the sheet expects.
- `hub_server/lib/tax.js` defaults to CGST 2.5% + SGST 2.5% with a per-tenant tax config; invoice numbers are `INV-000001` (per-tenant, not financial-year aware); there is no IGST path. A search found **no GSTIN or HSN/SAC** in the hub library. This is a quick search, not the G0-3 audit.
- The ten `/ops` rules are in `signup_server/lib/ops.js` (`OPS_LIMITS`), in the operator service and not a shared library, so they must be moved before the admin console can share them (still to settle).

## NOT DONE

Everything in the plan. The sheet's own §14 checklist (what migration 021 introduced, what the webhook handler overwrites, whether any route could touch bills, how the hub authenticates, redaction helpers) is still to be answered in the first report of Phase 1. Gates G0-1 and G0-2 (hosted migrations, Razorpay test mode) remain with people.

Status: ✅ the plan is written down and reconciled with the repo; 🚧 the console itself.
