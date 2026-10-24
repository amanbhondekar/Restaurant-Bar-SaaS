# Menu & Tables Admin Module — Design Spec

**Date:** 2026-10-02
**Status:** Approved in chat (sections 1–3), pending written-spec review

## Goal

Let a restaurant manage its own menu and table layout from the reception laptop: upload a menu file, edit dishes (including variants, modifiers, day-parts and 86'ing), and rearrange, rename and resize tables, with changes reaching waiters and the KDS live, working offline, and replicating to the cloud when online.

## Current state (why this is architectural)

- Menu and tables are **read-only on the hub**. `hub_server/lib/restaurantCache.js` pulls them from Supabase into `menu_cache.json` / `tables_cache.json`. There is no write route for either.
- Every online boot, every reconnect (`handleReconnection`) and every realtime event **overwrites** the local cache from Supabase, and substitutes the demo seed when the cloud tables are empty. A hub-side edit would be silently lost without changing this.
- `src/server_laptop/SelfServeAdminView.jsx` ("Menu Editor", "Floor Layout") is not in any built entry point (Vite builds only `index.html`, `waiter.html`, `dashboard.html`). Its edits go to React state / localStorage, and `PosContext` overwrites the menu from the hub every 4 s. It never reaches waiters or the KDS.
- The Supabase `menu_items` schema has no columns for `variants`, `modifier_groups`, `day_parts` or `station`; the hub reads them as JSONB but they only exist in the demo seed today. `tables.id` / `menu_items.id` are UUIDs in the cloud while the hub uses integers (`1`–`12`) and strings (`m1`).
- RLS on `tables`, `menu_categories`, `menu_items` is `FOR ALL` per tenant, so the hub's cloud identity can already write them.
- The sync queue knows only `CREATE_ORDER` and `UPDATE_STATUS`.
- The waiter floor grid hardcodes its section chips (`FloorGrid.jsx:33`). Waiter phones refetch `/menu` and `/tables` after **any** WebSocket message (`handleHubWsEvent` → `fetchLiveState`), so broadcasting `menu_updated` / `tables_updated` already updates them.
- Tickets are matched to tables loosely (`ticketStore.getActiveTicketsForTable`: id, `t<id>`, `table <id>`, or name).
- The hub's global JSON body limit is 256 KB.

## Decisions (user-approved)

| Topic | Decision |
|---|---|
| Menu upload | CSV/Excel import first (with an export that doubles as the template) plus a full item editor. Photo/PDF AI import is a later sub-project reusing the same preview/commit step. |
| Table "arrangement" | Sections + ordering + rename + seats + add/remove. **No** floor-plan canvas. |
| Who edits, where | Reception laptop only. Waiter phones cannot edit. Remote owner editing is out of scope. |
| Authority | Hub is the source of truth; edits replicate to Supabase through the sync queue (Approach A, delivered in three phases). |

## Non-goals

- Remote owner editing through the cloud dashboard; cloud-to-hub conflict resolution.
- Photo/PDF AI menu extraction.
- Floor-plan canvas, table shapes or x/y positions.
- Item images and descriptions.
- Deleting the legacy `SelfServeAdminView` / `PosContext` admin actions (separate cleanup).
- `hub_server/data/*.json` runtime data is never staged in commits.

## 1. Hub write layer — Phase 1

`restaurantCache` stays the read facade, so `/menu`, `/tables/layout` and the WebSocket `CONNECTED` handshake are unchanged. Writes go through new validated paths into the same cache files.

**Shared normaliser.** The inline per-item normalisation in `fetchMenuFromSupabase` (variants, modifier groups, day-parts, station) moves to `hub_server/lib/menuNormalize.js`. The cloud seed and the editor routes use it (the importer validates rows with its own strict parser), so a malformed row cannot reach the pricer from any source. Golden tests pin its output to the previous behaviour; equivalence with the old inline mapper on the demo seed plus 50,000 random rows was also checked once by a differential run.

**Authority and revisions.** Each cache file gains an integer `revision`, bumped on every local write. While `revision > 0`, boot sync, reconnect and realtime events no longer overwrite that catalog. Every write carries `base_revision`; a stale value returns 409. Each write also keeps a rolling backup (last 10 per catalog) in `hub_server/data/backups/`, which is added to `.gitignore`.

**Access.** New `requireReception` guard: loopback / trusted local address only. Enrolled handsets get 403 `RECEPTION_ONLY`. Under `HUB_TRUST_LOOPBACK=false` no one qualifies, so tests spawn the hub in both modes. The `/admin` page route (Phase 2) returns a plain "Reception only" 403 to non-local callers.

**Routes** (all new):

| Route | Purpose |
|---|---|
| `POST /admin/menu/items`, `PUT/DELETE /admin/menu/items/:id` | Item CRUD (basics, variants, modifier groups, day-parts, station, availability) |
| `POST /admin/menu/categories`, `PUT /admin/menu/categories` (`{from,to}`), `PUT /admin/menu/categories/order`, `DELETE /admin/menu/categories?name=` | Add, rename (re-labels items), reorder, delete (only when empty) |
| `POST /admin/menu/import/preview` | Validates rows; returns per-row status (new / updated with field diff / unchanged / error) and counts. No write. |
| `POST /admin/menu/import/commit` | Applies in one atomic write. Mode `merge` (default) or `replace`. Re-validates server-side; never trusts the preview. |
| `PUT /admin/tables/layout` | Saves the whole layout in one call: ordered `sections` plus `tables` (`id?`, `name`, `section`, `capacity`). |

The import routes get their own 2 MB JSON parser mounted **ahead of** the global 256 KB parser (a body already parsed is skipped by the later one).

Writes require `base_revision` (JSON body, or query string for DELETE); a missing value returns 400 `BASE_REVISION_REQUIRED`. `PUT /admin/menu/items/:id` merges the keys you send and preserves the rest (send `[]` to clear variants, modifier groups or day-parts). `import/commit` with mode `replace` additionally requires `confirm_replace: true` (else 400 `CONFIRM_REQUIRED`). A hub that has never loaded a catalog returns 409 `HUB_UNINITIALIZED` for edits until it has been online once.

**Ids.** New menu items get `m_<8 hex>` ids. New tables get integer ids from a persisted `next_id` counter that is never reused, so an id can't alias a deleted table's history. Categories remain an ordered array of names.

**Limits and field rules** (editor and importer share them): item name 1–120 chars, category 1–60, price and variant prices > 0 with at most 2 decimals, variant label ≤ 40, at most 2000 rows per import, `station` ∈ `hot | cold | bar`.

**Table rules.** Names are unique, case-insensitive. A table with an open bill cannot be renamed or deleted (409 `TABLE_HAS_OPEN_BILL`, naming the tables). Moving a table between sections and changing seats are always allowed.

**Live update.** After each commit the hub broadcasts `menu_updated` / `tables_updated`. `/tables` and `/tables/layout` gain `sections` (ordered; falls back to distinct sections in order of first appearance).

**Fixes included.**
- Waiter `FloorGrid` derives its section chips from `sections` instead of the hardcoded list.
- The `MASTER_TABLES` fallback in `server.js` stops resurrecting demo tables when a layout is legitimately empty; it applies only to an uninitialised hub.

Orders re-price from the hub menu at `POST /orders`, so edits apply to the next order. Open tickets keep their item snapshot, so deleting a dish never breaks an open bill.

## 2. Reception editor and import — Phase 2

**Where.** New `admin.html` + `src/admin_main.jsx` + `src/admin/*`, served at `/admin` like `/dashboard` and `/waiter`, added to the Vite inputs. It is **not** built into `kitchen_main.jsx` (the Stitch redesign is about to split and restyle that file). The KDS header gets one small "Menu & Tables" link. The page reuses `src/components/ui/*` and the design tokens.

**Menu tab.** Category rail (add, rename, reorder, delete when empty) beside an item table with search. Each row shows name, price, veg, station, an 86'd/available toggle, and badges for variants / modifiers / day-parts. A row opens an item-editor sheet: basics, variants, modifier groups with per-option 86'ing, and day-parts (built last). Saving a basic edit never drops variants, modifiers or day-parts.

**Import flow.**
1. "Import menu" opens a dialog. The template is an **export of the current menu**, so a CSV round-trips and doubles as a backup.
2. The browser parses `.csv` or `.xlsx` into plain string rows (a small maintained xlsx reader, lazy-loaded). The hub never receives the file.
3. Rows go to `import/preview`. The review table tags each row New, Updated (changed fields shown), Unchanged or Error (row number and reason).
4. The restaurant picks **Merge** (default) or **Replace entire menu**. Replace shows how many items will be removed and requires typing a confirmation. Errors block the commit unless "import valid rows only" is ticked.

**File rules.**
- Columns: `id` (optional), `name`, `category`, `price`, `veg`, `available`, `station`, `variants`.
- Row matching: `id` if present and known, otherwise name + category (case-insensitive, trimmed).
- A column absent from the file, or a blank cell on an existing item, **never overwrites** the stored value. Modifier groups and day-parts are not importable; they are edited in the editor and survive re-imports.
- New rows: `name`, `category`, `price` (or `variants`) and `veg` are required. `veg` accepts yes/no/true/false/1/0/veg/non-veg and is **required** for new items so a non-veg dish is never silently labelled veg. New rows default `available` to true and `station` to hot.
- `variants` uses `Label:price|Label:price`. When present it **replaces** the item's variant list; a label matching an existing variant (case-insensitive) keeps that variant's id and 86'd state, new labels get a slug id (`v_<label>`, with `_2`, `_3` appended on a slug collision within the item), omitted labels are removed. If `price` is blank the top-level price defaults to the first variant's price (it is a display fallback only; the pricer ignores it for variant items).
- New categories are created in order of appearance.

**Tables tab.** Section cards hold draggable table chips: drag reorders within a section and moves across sections, with a keyboard-accessible "Move to…" menu as the alternative. Inline rename, seats stepper, add and delete per table; add, rename, reorder and delete for sections (empty only). Tables with open bills show a lock badge. Edits stay in a local draft; a sticky bar with **Save layout / Discard** commits once. A 409 shows a "layout changed, reload" banner.

**UX baseline on every screen.** Loading skeletons, empty states, error banners with retry, visible "Saved on hub" status (cloud-pending count arrives in Phase 3), keyboard focus rings.

## 3. Cloud write-through — Phase 3

**Migration** `database/migrations/003_menu_tables_hub_authority.sql`:
- `menu_items`: add `variants JSONB`, `modifier_groups JSONB`, `day_parts JSONB`, `station VARCHAR(20)`.
- `menu_items`, `menu_categories`, `tables`: add `hub_ref TEXT` with a unique index on `(restaurant_id, hub_ref)`. The hub keeps its own ids and upserts on `hub_ref`, so no re-id mapping is needed and open tickets stay valid. For categories, `hub_ref` is the name (rename = delete + insert on the cloud, harmless because items reference `category_name`).

**Queue.** New operations `SYNC_MENU` and `SYNC_TABLES`, each carrying a full snapshot with its revision. Enqueueing replaces any pending op of the same type, so they are idempotent and a day offline with many edits becomes one push. Cloud rows absent from the snapshot are deleted. Poison items reuse the existing quarantine.

**Status.** `/sync-status` gains per-catalog `revision` and `synced_revision`; the editor shows "Saved on hub · Cloud: synced / pending / failed (retry)".

**Recovery.** The cloud-pull mapper prefers `hub_ref` over `id`, and the tables pull orders by `display_order` (set from layout order on every push) instead of `id`, so a replacement hub laptop recovers the menu and layout from the cloud. Section order is recovered as first appearance in that order, so an empty section does not survive recovery.

**Trade-off.** The hub is the single writer. Edits made directly in the Supabase dashboard while the hub holds local edits are overwritten by the next push.

**Verification caveat.** This phase is verified against a mocked Supabase client only; real-cloud verification requires the user to apply the migration to their project.

## 4. Failure handling

- Errors use the existing `{ success:false, error, code }` shape: `RECEPTION_ONLY` (403), `STALE_REVISION` (409), `TABLE_HAS_OPEN_BILL` (409), `INVALID_ROWS` (400, with row details), `NO_VALID_ROWS` (400, a replace or merge import that leaves no valid row, so nothing is written), oversize bodies 413 `PAYLOAD_TOO_LARGE` and malformed JSON 400 `INVALID_JSON` (both answered as JSON for `/admin` routes only). `base_revision` is strict: body routes take it as a JSON integer and DELETE routes as a digits-only query string; anything else is 400 `BASE_REVISION_REQUIRED`.
- Admin writes go to a temp file then rename, and the in-memory cache is swapped only after success. (Today `saveMenuToDisk` mutates memory before the disk write.) A failure returns 500 `WRITE_FAILED` and leaves state unchanged.
- All catalog writes are serialised through a single promise chain so read-modify-write cannot interleave.
- A cloud-sync failure never blocks or rolls back an edit.

## 5. Testing

Hub `node --test` (existing harness, temp `HUB_DATA_DIR`):

- normaliser golden tests (hand-built hostile and legacy rows; seed equivalence was verified once by a differential run, not by a committed test);
- item CRUD, category rename/reorder/delete rules, 409 on stale revision, backup rotation;
- import preview and commit: merge, replace, field diffs, absent-column and blank-cell preservation, variant id retention, required `veg`, row errors, 2 MB body accepted;
- table rules: unique names, open-bill lock, last-table delete does not resurrect demo tables, id counter never reuses;
- authority guard: a reconnect pull does not overwrite once `revision > 0`;
- guard: enrolled token gets 403, loopback passes (both trust modes);
- WebSocket `menu_updated` / `tables_updated` broadcast;
- Phase 3: queue coalescing and `hub_ref` round trip against a mock client.

Browser pane (no UI test runner exists and none is claimed): the admin page at phone, tablet and desktop widths in light and dark; a waiter phone showing new and renamed section chips live; import round trip with a real CSV; console clean.

## 6. Rollout and housekeeping

Three independently shippable steps: **Phase 1** hub write layer (backward compatible, no UI), **Phase 2** admin page and import, **Phase 3** cloud write-through. Each phase gets its own implementation plan, written in that order; Phase 1's plan comes first. Per `.agents/rules/darshil_documentation_rule.md`, each step adds `Darshil_docs/reports/report_YYYY-MM-DD_<feature>.md` and a `Darshil_docs/README.md` index row. Small commits with explicit `git add <path>`; never `-A` and never `hub_server/data/*.json`.

Implementation-plan choices constrained by this spec: the specific xlsx reader package (small, maintained, browser-capable, lazy-loaded) and the drag-and-drop mechanism (native HTML5 DnD or pointer events; no new dependency preferred, with the keyboard "Move to…" path always present).

## 7. Risks

| Risk | Mitigation |
|---|---|
| Hub edits lost to a cloud pull | Revision-based authority guard in Phase 1, before any edit UI exists |
| Replace-import wipes the menu by mistake | Preview with removal count, typed confirmation, rolling backups |
| Renaming/deleting a table with an open bill orphans tickets | Server-enforced open-bill lock |
| Cloud overwrite of dashboard-made edits | Documented single-writer trade-off |
| Migration not applied before Phase 3 ships | Phase 3 is optional at runtime: queue ops quarantine on schema errors and never block edits |
| Conflicts with the Stitch redesign of `kitchen_main.jsx` | Separate `/admin` page; a single header link is the only KDS change |
