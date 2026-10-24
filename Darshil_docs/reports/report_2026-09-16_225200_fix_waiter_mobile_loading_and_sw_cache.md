# Fix: Waiter Mobile Loading Stalling & Service Worker Dev Cache Resolution

**Timestamp**: 2026-09-16 22:52:00 IST  
**Environment**: Production Dev Server (Vite port 3000, Hub port 4000)  
**Author**: Antigravity AI Pair Programmer  

---

## 1. Issue Description
The user reported that `http://192.168.31.156:3000/waiter.html` was not loading on their mobile phone after the recent QR and PWA additions.

---

## 2. Root Cause Analysis
1. **Vite Dynamic Dependency Optimization Stall**:
   - At `21:59:51`, when `html5-qrcode` was installed via `npm i`, the running Vite dev server logged:
     `✨ new dependencies optimized: html5-qrcode`
     `✨ optimized dependencies changed. reloading`
   - In Vite v6, on-the-fly pre-bundling changes the hash signature (`?v=...`) of all cached dependencies. Active client connections from mobile handsets stalled waiting for the server to settle.
2. **Service Worker Interception of Dev Modules**:
   - The handset had previously registered `public/sw.js`.
   - When Vite reloaded dependencies with new module hashes, the Service Worker intercepted internal module requests (`/node_modules/.vite/deps/...`, `/@react-refresh`) and attempted to serve older cached responses or failed promises.
   - This caused the mobile browser to hang on an infinite loading state or blank screen.

---

## 3. Resolution Applied
1. **Fresh Vite Dev Server Restart**:
   - Killed stale Vite process (task-226) and started a clean instance (task-690). Both port 3000 and port 4000 verified listening on `0.0.0.0` and responding with HTTP 200.
2. **Service Worker Dev-Mode Bypass (`public/sw.js`)**:
   - Incremented cache to `mejwani-waiter-v3`.
   - Added rule #0 in the fetch handler:
     ```javascript
     if (url.port === '3000' || url.pathname.startsWith('/@') || url.pathname.startsWith('/src/') || url.pathname.startsWith('/node_modules/')) {
       return; // Never intercept Vite dev server requests
     }
     ```
3. **Auto-Purge of Dev Service Worker (`waiter.html`)**:
   - In `waiter.html`, when running on port 3000 (Vite dev server), it automatically unregisters any active service workers and purges stale CacheStorage entries:
     ```javascript
     if (window.location.port === '3000') {
       navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
       caches.keys().then(names => names.forEach(n => caches.delete(n)));
     }
     ```
4. **Dual Port Availability**:
   - Rebuilt production bundle (`npm run build`). The app is now fully available either via:
     - Vite Dev Server: `http://192.168.31.156:3000/waiter.html`
     - Hub Production Server: `http://192.168.31.156:4000/waiter.html`
