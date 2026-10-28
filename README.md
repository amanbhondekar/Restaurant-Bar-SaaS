# 🍽️ SAAS Restaurant — Multi-Tenant LAN-First POS & Kitchen Display Engine

[![Architecture: LAN-First](https://img.shields.io/badge/Architecture-LAN--First_Offline_Engine-orange.svg)](#architecture-overview)
[![Stack: Node Express + Vite React](https://img.shields.io/badge/Stack-Node.js_|_Express_|_React_18_|_Vite-blue.svg)](#technology-stack)
[![Security: Supabase RLS](https://img.shields.io/badge/Security-Supabase_RLS_Isolated-green.svg)](#multi-tenant-database--rls-security)
[![PWA: Installable Handset](https://img.shields.io/badge/PWA-Installable_Waiter_App-purple.svg)](#waiter-mobile-handset-pwa)

An enterprise-grade, offline-first restaurant Point of Sale (POS) and Kitchen Display System (KDS) designed specifically for high-volume dining environments. Built and field-validated with pilot partner **Hotel Mejwani** (Nagpur).

---

## 📐 Architecture Overview

In busy restaurant environments, internet connectivity is intermittent and unreliable. Traditional cloud-dependent POS systems freeze during internet outages, creating severe operational bottlenecks.

This system decouples order entry from cloud dependencies using a **LAN-First Architecture**:

```
                              +-------------------------------------------------------------+
                              |                      RECEPTION LAPTOP                       |
                              |                                                             |
                              |  +-------------------------------------------------------+  |
                              |  |                Hub Server (Node/Express)              |  |
                              |  |                     Binds: 0.0.0.0                    |  |
                              |  |                                                       |  |
                              |  |  * POST /orders               * GET /orders/active    |  |
                              |  |  * POST /orders/:id/ready     * GET /tables           |  |
                              |  |  * WS /live                   * GET /sync-status      |  |
                              |  +---------------------------+---------------------------+  |
                              |                              |                              |
                              |               Serves static  | Async Cloud Sync             |
                              |               build at /     | (RLS Kitchen Staff Auth)     |
                              |                              v                              |
                              |  +-------------------------------------------------------+  |
                              |  |             Kitchen Hub Display (Browser)             |  |
                              |  |  - Displays pairing code & QR code for LAN IP         |  |
                              |  |  - Restores open tickets from GET /orders/active      |  |
                              |  |  - Listens to real-time tickets via WS /live          |  |
                              |  |  - Displays live cloud sync status indicator          |  |
                              |  +-------------------------------------------------------+  |
                              +------------------------------^------------------------------+
                                                             |
                                                             | HTTP / WS over LAN WiFi
                                                             | (Zero Internet Required)
                                                             |
                                              +--------------+--------------+
                                              |   Waiter Phone (Local WiFi) |
                                              |  +-----------------------+  |
                                              |  |   Standalone PWA      |  |
                                              |  |   (manifest + sw)     |  |
                                              |  |   - QR Scanner Pair   |  |
                                              |  |   - Rapid Order Build |  |
                                              |  |   - Offline State UI  |  |
                                              |  +-----------------------+  |
                                              +-----------------------------+
```

1. **Local Network Path (Order → Kitchen)**: Waiter devices send orders directly to the reception laptop over local WiFi (`http://<LAN-IP>:4000/orders`). Tickets appear on the Kitchen Display in **< 1 second** without touching the internet.
2. **Cloud Path (Order → Supabase)**: Orders are queued in a persistent local disk queue (`hub_server/data/tickets.json`) and asynchronously synchronized to Supabase in the background when WAN internet is active.

---

## 📂 Repository Directory Structure

```
SAAS_Restaurant/
├── database/                         # Database Schemas & Migrations
│   └── supabase_schema.sql           # Multi-tenant RLS PostgreSQL Schema
├── docs/                             # Engineering & Technical Documentation
│   ├── ARCHITECTURE.md               # LAN Topology & Sequence Diagrams
│   ├── API_SPECIFICATION.md          # Hub Server REST & WebSocket API Specs
│   ├── DEPLOYMENT_GUIDE.md           # Production Deployment & Pairing Guide
│   ├── OWNER_VIEW.md                 # The remote, read-only owner view: runbook
│   ├── ROADMAP.md                    # What is shipped, partial and not started
│   └── pilot-report-template.md      # Template for the field report after a pilot
├── hub_server/                       # Node/Express + WebSocket Hub Gateway Core
│   ├── data/                         # Local Persistent Disk Stores (tickets.json)
│   ├── lib/                          # Hub Services (hubConfig, syncQueue, ticketStore, supabaseClient)
│   └── server.js                     # Gateway Entry Point (Binds to 0.0.0.0:4000)
├── src/                              # Main Frontend React Application Source
│   ├── components/                   # Shared UI Components (Header, Modals)
│   ├── context/                      # React POS State Context & Reducers
│   ├── server_laptop/                # Kitchen Display & Admin Modules
│   │   ├── KitchenKdsView.jsx        # Live KDS Ticket Rail & Checklists
│   │   ├── SalesAnalyticsView.jsx    # Real-Time Revenue & Order Analytics
│   │   ├── SelfServeAdminView.jsx   # Menu, Pricing & Table Layout Manager
│   │   └── ServerLaptopApp.jsx       # Kitchen Reception Main View
│   ├── waiter_mobile/                # Waiter Mobile Handset PWA Views
│   │   ├── WaiterApp.jsx             # Standalone PWA Root & Connection Guard
│   │   ├── FloorGrid.jsx             # Live Table Status Floor Grid
│   │   ├── MenuGrid.jsx              # Category Filtered Menu Grid
│   │   └── OrderDraftDrawer.jsx      # Mobile Cart Drawer & LAN HTTP Dispatcher
│   ├── services/                     # Core Business & Network Layer Services
│   │   ├── lanBus.js                 # LAN BroadcastChannel & Fallback Event Bus
│   │   ├── db.js                     # Local Storage & Offline State Adapter
│   │   └── supabaseSync.js           # Cloud Synchronization Worker
│   ├── kitchen_main.jsx              # React Entry Point for Kitchen KDS (`dist/index.html`)
│   ├── waiter_main.jsx               # React Entry Point for Waiter PWA (`dist/waiter.html`)
│   ├── App.jsx                       # Dual Demo & Standalone Shell Root
│   └── index.css                     # Global Design Tokens & Kullina Theme Engine
├── public/                           # Static Web Assets & PWA Specs
│   ├── manifest.json                 # Web App Manifest (`display: standalone`)
│   └── sw.js                         # PWA Service Worker Cache Handler
├── misc/                             # Prototypes, Demos & Design Assets
│   ├── demos/                        # Single-file Pitch & Architectural Prototypes
│   │   ├── mejwani-offline-pos-demo.html
│   │   ├── mejwani-pos-demo.html
│   │   └── pin-login-flow-tester.html
│   └── design_assets/                # Kullina Design System Theme Specs
├── index.html                        # Kitchen KDS HTML Entry Point
├── waiter.html                       # Waiter PWA HTML Entry Point
├── package.json                      # NPM Dependencies & Scripts
├── vite.config.js                    # Vite Multi-Entry Rollup Build Configuration
└── README.md                         # Project Master Documentation
```

---

## ⚡ Technology Stack

- **Frontend Core**: React 18, Vite 6, Modern Vanilla CSS (Kullina Design Tokens).
- **Local Hub Server**: Node.js, Express, WebSocket (`ws`), Node Native `fetch`.
- **Database & Auth**: Supabase (PostgreSQL, Realtime, Row Level Security, `pgcrypto`).
- **PWA Capabilities**: Service Workers, Web App Manifest, Standalone Home Screen Installation.
- **Hardware Integration**: Responsive Layouts optimized for Mobile Handsets & KDS Touch Displays.

---

## 🛠️ Quick Start Guide

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **Local Wi-Fi Network**: Both laptop and waiter mobile phones connected to the same local Wi-Fi router.

### 1. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/Darshil-yup/SAAS_Restaurant.git
cd SAAS_Restaurant
npm install
```

### 2. Build Static Production Bundles
Build both the Kitchen Display (`dist/index.html`) and Waiter PWA (`dist/waiter.html`):
```bash
npm run build
```

### 3. Start the Local POS Hub Server
Launch the Hub Gateway server on your laptop (Binds to `0.0.0.0:4000`):
```bash
npm run hub
```

Terminal output will display:
```text
======================================================
  MEJWANI LOCAL POS HUB SERVER (LAN-FIRST CORE)
======================================================
  Status:          RUNNING
  LAN IP:          http://192.168.1.50:4000
  Kitchen KDS:     http://192.168.1.50:4000/
  Waiter App PWA:  http://192.168.1.50:4000/waiter
  WebSocket:       ws://192.168.1.50:4000/live
======================================================
```

---

## 📱 Pairing & Using the System

1. **Kitchen KDS**: Open `http://localhost:4000` (or `http://<LAN-IP>:4000`) on the laptop. The screen displays the tenant pairing code (**`MJW-7492`**) and a dynamic QR code.
2. **Waiter Handset**: Open `http://<LAN-IP>:4000/waiter` on any mobile phone connected to the local Wi-Fi (or scan the QR code).
3. **PWA Installation**: Tap **Add to Home Screen** on your phone to install the standalone Waiter App.
4. **Placing Orders**:
   - Tap any open table (e.g., **Table 4**).
   - Add items and tap **Send to Kitchen**.
   - Table 4 instantly turns **Amber ("In Kitchen")** on both the phone and Kitchen KDS.
   - Tap **Mark Ready** on the Kitchen Display → Table 4 instantly turns **Blue ("Bill Ready")** on the phone!

---

## 🔒 Multi-Tenant Database & RLS Security

The system enforces tenant isolation at the **PostgreSQL Database Level** using Supabase Row Level Security (RLS). 

- Every table contains a mandatory `restaurant_id` column.
- The `current_restaurant_id()` security definer function maps the authenticated `auth.uid()` session to `staff_users.restaurant_id`.
- The Hub Server authenticates securely using an anonymous kitchen staff session mapped to a dedicated `role = 'kitchen'` row, guaranteeing zero-trust isolation **without relying on master service keys**.

---

## 📄 License & Maintainer

Maintained by **Darshil & Engineering Team**.  
Built for high-reliability restaurant operations worldwide.
