# 📁 Darshil Docs — Automated Developer & Tester Audit Repository

Welcome to **Darshil Docs**, the authoritative audit log and testing repository for the SAAS Restaurant POS & KDS platform.

## 📌 Standard Operating Procedure (SOP) for Agents & Developers

For **every code modification or feature addition**, the assistant/developer **MUST**:

1. **Document WHAT changed**: List exact files, lines, endpoints, component props, database queries, and architectural modules created or edited.
2. **Document WHY it changed**: Detail the root cause, bug symptoms, business requirement, or architectural rationale for the change.
3. **Provide Comprehensive Test Cases**:
   - Test Case ID & Title
   - Pre-conditions & Environment Setup
   - Step-by-step Execution Steps
   - Expected vs Actual Behavior
   - Automated/Manual Verification Commands & Log Outputs
4. **Maintain Timestamped Audit Logs**: Save individual reports in `Darshil_docs/reports/` using the format `YYYY-MM-DD_HHMMSS_<feature_name>.md`.

---

## 🗂 Index of Timestamped Change & Test Reports

| Date & Timestamp | Report Document | Primary Scope / Feature | Status |
|---|---|---|---|
| 2026-09-03T20:15:00+05:30 | [`report_2026-09-03_201500_kullina_theme_merge_and_runtime_reconciliation.md`](./reports/report_2026-09-03_201500_kullina_theme_merge_and_runtime_reconciliation.md) | Kullina Theme Merge Reconciliation, Unified Typography/Status Tokens & Runtime Bug Fix Verification | ✅ VERIFIED & COMMITTED |
| 2026-08-20T22:06:35+05:30 | [`report_2026-08-20_220635_hub_persisted_menu_table_cache_and_offline_boot.md`](./reports/report_2026-08-20_220635_hub_persisted_menu_table_cache_and_offline_boot.md) | Hub Local Menu and Table Layout Disk Caching, Boot Sync & Realtime Offline Resilience | ✅ VERIFIED & COMMITTED |
| 2026-08-19T20:31:00+05:30 | [`report_2026-08-19_203100_fix_bidirectional_live_ws_sync.md`](./reports/report_2026-08-19_203100_fix_bidirectional_live_ws_sync.md) | Resolve Kitchen -> Waiter Live WebSocket Sync Bug with Unified `handleHubWsEvent` Funnel | ✅ VERIFIED & COMMITTED |
| 2026-08-19T20:21:00+05:30 | [`report_2026-08-19_202100_kullina_light_design_and_framer_motion.md`](./reports/report_2026-08-19_202100_kullina_light_design_and_framer_motion.md) | Implement Kullina Light Design System & Framer Motion Ticket Printer Animation | ✅ VERIFIED & COMMITTED |
| 2026-08-19T20:12:00+05:30 | [`report_2026-08-19_201200_fix_clear_bill_and_kitchen_qr_loader.md`](./reports/report_2026-08-19_201200_fix_clear_bill_and_kitchen_qr_loader.md) | Connect Clear Bill Button to Hub LAN Endpoint & Fix Kitchen Display QR Port Resolution | ✅ VERIFIED & COMMITTED |
| 2026-08-19T20:00:00+05:30 | [`report_2026-08-19_200000_fix_kitchen_main_use_ref_import.md`](./reports/report_2026-08-19_200000_fix_kitchen_main_use_ref_import.md) | Add Missing `useRef` Import to Fix Blank White Page `ReferenceError` in Kitchen Display | ✅ VERIFIED & COMMITTED |
| 2026-08-19T19:43:49+05:30 | [`report_2026-08-19_194349_waiter_chrome_and_kitchen_connection_badge.md`](./reports/report_2026-08-19_194349_waiter_chrome_and_kitchen_connection_badge.md) | Remove Pitch-Demo Device Chrome and Add Neutral Connecting State to Connection Badges | ✅ VERIFIED & COMMITTED |
| 2026-08-18T22:23:00+05:30 | [`report_2026-08-18_222300_in_memory_auth_session_persistence_fix.md`](./reports/report_2026-08-18_222300_in_memory_auth_session_persistence_fix.md) | Enable In-Memory Session Persistence (`persistSession: true`), Cached Authentication Flag (`isHubAuthenticated`), Pre-Insert `auth.uid()` Sanity Logging | ✅ VERIFIED & COMMITTED |
| 2026-08-18T22:14:00+05:30 | [`report_2026-08-18_221400_security_definer_user_id_binding_rls_fix.md`](./reports/report_2026-08-18_221400_security_definer_user_id_binding_rls_fix.md) | Bind `user_id` inside `SECURITY DEFINER` RPC `provision_kitchen_staff` to resolve Postgres RLS `42501` `orders` policy rejection | ✅ VERIFIED & COMMITTED |
| 2026-08-18T22:10:00+05:30 | [`report_2026-08-18_221000_fix_hubconfig_reference_and_pin_code_rpc.md`](./reports/report_2026-08-18_221000_fix_hubconfig_reference_and_pin_code_rpc.md) | Fix `ReferenceError: hubConfig is not defined`, Replace `pin_code` column insert with `provision_kitchen_staff` RPC function & `pin_hash` pgcrypto hashing | ✅ VERIFIED & COMMITTED |
| 2026-08-18T19:51:00+05:30 | [`report_2026-08-18_195100_unmask_supabase_sync_errors.md`](./reports/report_2026-08-18_195100_unmask_supabase_sync_errors.md) | Network vs RLS/Auth Error Separation, Pre-Sync Auth Session Audit Logging, Unmasked Supabase Payload Error Output | ✅ VERIFIED & COMMITTED |
| 2026-08-18T19:22:00+05:30 | [`report_2026-08-18_192200_sync_retry_loop_fix.md`](./reports/report_2026-08-18_192200_sync_retry_loop_fix.md) | Background Cloud Sync Perpetual Retry Rescheduling Loop (`startSyncLoop`) & Explicit Terminal Attempt/Recovery Logging | ✅ VERIFIED & COMMITTED |
| 2026-08-18T18:31:12+05:30 | [`report_2026-08-18_hub_performance_idempotency_dashboard.md`](./reports/report_2026-08-18_hub_performance_idempotency_dashboard.md) | Async non-blocking I/O, Request Idempotency (`order_request_id`), Live Hub Operational Dashboard (`/dashboard`), & Full-Bleed PWA UI Cleanup | ✅ VERIFIED & COMMITTED |
