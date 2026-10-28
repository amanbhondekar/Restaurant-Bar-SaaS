# Waiter Handset Device Enrollment & Tables Floor Grid Loading Resolution Report

**Timestamp**: 2026-09-16 20:46:00 IST  
**Environment**: Production Dev Server (Vite port 3000, Hub port 4000)  
**Author**: Antigravity AI Pair Programmer  

---

## 1. Issue Description & User Observation
When accessing the Waiter PWA interface from a physical smartphone on local Wi-Fi (`http://192.168.31.156:3000/waiter.html`):
- The top header displayed a green `LAN Connected` badge and detected the hub at `192.168.31.156:4000`.
- However, the table floor grid was completely blank, displaying the empty placeholder message:
  > *"No tables in this section. Try selecting a different section above."*
  > *"No table selected. Tap any table above to start an order for Hotel Mejwani."*

---

## 2. Root Cause Analysis
1. **Misleading Connection Status**:
   - `checkHubConnection` polled `GET /pairing-info`.
   - `/pairing-info` is deliberately a public unauthenticated health probe (HTTP 200).
   - Because `res.ok` was `true`, the UI set `connStatus = 'connected'` and showed a green `LAN Connected` badge, ignoring `data.authorised: false`.
2. **Silent 401 Rejection on Sensitive Endpoints**:
   - For security, non-loopback devices (smartphones on LAN Wi-Fi) require device authorization via a bearer token for `/tables`, `/orders/active`, and `/menu`.
   - When `fetchLiveState` fetched `/tables`, the Hub returned `401 Unauthorized`.
   - The promise catch handler silently ignored the error, leaving `liveTables = []`.
   - Because `liveTables` was empty, `FloorGrid` rendered the empty-section placeholder.
3. **Missing Onboarding Prompts**:
   - The handset had no active token and had not enrolled, but the UI never prompted for the enrollment code (`9KZXEC`) or indicated that device enrollment was required.

---

## 3. Resolution Applied
1. **Explicit Unauthorized State in `WaiterApp.jsx`**:
   - Added `'unauthorized'` state to `connStatus`.
   - If `/pairing-info` returns `authorised: false` and device lacks a token, or if `/tables`/`/menu`/`/orders` returns HTTP 401, `connStatus` transitions to `'unauthorized'`.
2. **Visual Guidance & Enrolment Banners**:
   - Header badge shows amber `🔑 Enter Code` (`.conn-pill-warning`).
   - Added sticky notification banner: `🔐 Handset not enrolled. Enter Kitchen Display code to load tables.` with quick `[Enter Code]` button.
   - `FloorGrid.jsx` empty state now recognizes `connStatus === 'unauthorized'` and displays:
     - `🔐 Handset Not Enrolled`
     - `Enter the 6-character enrollment code shown on the Kitchen Display to view tables and take orders.`
     - Prominent `[Enter Enrollment Code]` action button.
3. **Auto-Fill & Simplified Enrollment**:
   - Pre-fills `manualIpInput` with detected LAN IP (`192.168.31.156:4000`).
   - Automatically surfaces the enrollment modal on initial detection.
   - Waiter only needs to type the 6-character code (`9KZXEC`) or scan the KDS QR code.
4. **Token Storage & Auto-Refresh**:
   - Upon entering `9KZXEC`, `enrollWithCode` trades the code for a 30-day token, persists it in `localStorage`, and triggers `fetchLiveState()`, rendering all 12 tables instantly.

---

## 4. Verification Results
- **Bundle Production Build**: `npm run build` compiled cleanly in 5.63s without errors.
- **Automated Test Suite**: `npm test` verified 15/15 tests passing, including device enrollment tests:
  - `✔ C2: unauthenticated order entry is refused`
  - `✔ C2: /pairing-info stays public but leaks no credentials`
  - `✔ C2: the correct enrollment code issues a working token`
  - `✔ order -> ready -> clear still works for an enrolled device`
