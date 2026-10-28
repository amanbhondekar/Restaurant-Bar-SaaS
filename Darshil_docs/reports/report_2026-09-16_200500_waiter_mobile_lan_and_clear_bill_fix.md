# 📄 Audit Report: Waiter Mobile LAN Access & Clear Bill Real-Time Fix

- **Date & Timestamp**: `2026-09-16T20:05:00+05:30`
- **Scope**: Resolving Waiter Mobile LAN connectivity (Firewall & Host Binding), Fixing Clear Bill optimistic UI updates & error reporting, and Wiring `authWsUrl` for WebSocket real-time event reception on mobile devices.
- **Status**: ✅ VERIFIED & RESOLVED

---

## 1. WHAT Changed (Files, Lines & Modules)

1. **`src/waiter_mobile/WaiterApp.jsx`**:
   - Imported and wired `authWsUrl` into `connectWs()`, attaching `?token=` parameter so non-loopback handsets and mobile browsers are not rejected by the hub with `401 Unauthorized`.
   - Updated `hubUrl` initialization to dynamically detect mobile LAN hostname (`192.168.31.156:4000`) instead of being locked to `localhost:4000`.
   - Enhanced `handleClearTableBill`:
     - Added instant optimistic UI update (table turns to `available` with ₹0 active bill immediately).
     - Added error alerts and automatic pairing modal trigger when receiving `401 Unauthorized` (prompting for enrollment code `9KZXEC`).
     - Added update from server response `data.tables` to keep floor grid authoritative.

2. **`hub_server/lib/syncQueue.js`**:
   - Added graceful insert retry fallback if `order_request_id` column has not yet been migrated in Supabase remote schema, preventing PGRST204 errors.

---

## 2. Root Cause Analysis: Why These Issues Occurred

### Problem 1: "Not able to clear bill"
- **Root Cause**:
  1. `handleClearTableBill` previously had no optimistic update and silent error swallowing: if the device had an expired/missing token or network latency, `res.ok` was false and it did nothing with no alert.
  2. The WebSocket connection was opened without `authWsUrl`, causing the hub's `requireDevice` check to reject the live WebSocket connection from handsets. Handsets therefore never received the live `CLEAR_TABLE` broadcast from the hub.

### Problem 2: "Not able to open waiter screen on mobile browser"
- **Root Cause**:
  1. `localhost` on mobile browsers points to the phone itself, not the restaurant PC. The mobile phone must open the PC's Wi-Fi IP: `http://192.168.31.156:3000/waiter.html` or `http://192.168.31.156:4000/waiter`.
  2. Windows Defender Firewall blocks inbound TCP traffic on ports 3000 and 4000 from other LAN devices unless explicitly allowed via Windows Firewall rule.

---

## 3. Verification & Solution Steps

1. **Automated Suite**: `npm test` passed with **15/15 tests passing**.
2. **Frontend Build**: `npm run build` compiled clean with 0 errors.
3. **Hub Server API**: Verified `POST /tables/8/clear` successfully cleared Table 8 on the hub store.
