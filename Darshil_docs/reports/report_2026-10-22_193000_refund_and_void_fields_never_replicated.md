# A refund's time and a void's reason never reached the cloud

**Date:** 2026-10-22T19:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## THE BUG
Round-tripping bills made by the **real invoice store** through the cloud mapping showed two more field-name
mismatches (after `voided` vs `void`):

- The store writes `refund_at`; the cloud row read `refunded_at`. Every refunded bill went up with **no refund time**,
  and a hub restored from the cloud **lost its refunds from the cash reconciliation** (the ledger reads `refund_at`).
- The store writes `voided_reason`; the cloud row read `void_reason`. The reason a bill was voided never replicated.

Cash-ups were checked the same way and round-trip faithfully.

## THE FIX
`invoiceRow` reads the hub's names and writes the cloud's columns; `invoiceFromCloud` restores the hub's names.
The `cloud:check` probe bill uses the hub's vocabulary.

## TESTS
Written first and run against the unfixed code: they failed, then passed. (1) Every payment/void/refund field the
store writes must map to a cloud column or be listed as deliberately not replicated (`paid_by`, `voided_by`,
`refund_by`), so the next rename fails a test. (2) A refund keeps its time and a void its reason. (3) **The ledger's
payment events are identical before and after a trip to the cloud.** (4) A real cash-up survives the trip. Five
mutations; one survived (`payment_ref` on restore), the fixture was strengthened, and it is caught. Hub contract
tests: 24 passing.

## NOT DONE
Nothing has run against a real Supabase project; row-level security is proven by nothing.
