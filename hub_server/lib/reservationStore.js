import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  emptyState, normalizeState, book, setReservationStatus, addWalkIn, setWaitlistStatus,
  bookingsOn, queue, seatedWalkInCount, summarize, availability, remindersDue, markReminded, unmarkReminded, giveReward, takeBackReward, giveWalkInReward, takeBackWalkInReward,
  updateBooking, updateWalkIn
} from './reservations.js';
import { rewardDue } from './loyalty.js';
import { receiveRequests, pendingRequests, acceptRequest, declineRequest, settleLapsed, pruneDecided } from './bookingRequests.js';

// Bookings and the walk-in queue on disk (hub_server/data/reservations.json), around the pure rules
// in lib/reservations.js.
//
// Hub-local, like waiters and feedback. A booking is taken at the reception laptop over the phone or
// at the door, and the hub has to keep working with the internet down -- a restaurant that cannot
// look up tonight's bookings because its line is out has a worse problem than one without a cloud.
// Migration 011 copies them up so they survive the laptop; see lib/reservationSync.js.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.HUB_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'reservations.json');

export class ReservationStore {
  constructor(file = FILE) {
    this.file = file;
    this.listeners = [];
    this.tables = () => [];
    // Serialised, for the same reason as stock: a busy evening saves this often, and two unordered
    // writes can leave the file holding an older state than memory.
    this.writeChain = Promise.resolve();
    this.state = this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('❌ Could not read reservations.json:', err.message);
      return emptyState(null);
    }
    try {
      return normalizeState(JSON.parse(raw), null);
    } catch (err) {
      // Tonight's bookings are promises to real people. An unreadable file is set aside, never
      // overwritten: someone can still read the names out of it.
      const kept = `${this.file.replace(/\.json$/, '')}.corrupt-${Date.now()}.json`;
      try { fs.writeFileSync(kept, raw); } catch { /* nothing more can be done */ }
      console.error(`🚨 reservations.json is unreadable (${err.message}). Starting empty; the damaged file was kept as ${path.basename(kept)}.`);
      return emptyState(null);
    }
  }

  save() {
    const body = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain
      .then(() => fs.promises.writeFile(this.file, body, 'utf-8'))
      .catch(err => console.error('❌ Async save reservations error:', err));
    return this.writeChain;
  }

  flush() { return this.writeChain; }

  /** The table layout bookings are checked against; wired by server.js. */
  setTableProvider(fn) { this.tables = typeof fn === 'function' ? fn : () => []; }

  onChange(cb) {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter(l => l !== cb); };
  }

  /** A hub re-paired to another restaurant keeps the old book aside rather than muddling the two. */
  ensureTenant(restaurantId) {
    const current = this.state.restaurant_id;
    if (!restaurantId || current === restaurantId) return;
    if (current) {
      const archive = `${this.file.replace(/\.json$/, '')}.${String(current).replace(/[^\w-]/g, '_')}.json`;
      try { fs.writeFileSync(archive, JSON.stringify(this.state, null, 2)); } catch { /* best effort */ }
      console.warn(`📦 The booking diary belonged to another restaurant (${current}); kept as ${path.basename(archive)}.`);
      this.state = emptyState(restaurantId);
    } else {
      this.state = { ...this.state, restaurant_id: restaurantId };
    }
  }

  stateFor(restaurantId) {
    const current = this.state.restaurant_id;
    return !restaurantId || !current || current === restaurantId ? this.state : emptyState(restaurantId);
  }

  commit(restaurantId, op) {
    this.ensureTenant(restaurantId);
    const result = op(this.state);
    if (!result.ok) return result;
    if (result.data !== this.state) {
      this.state = result.data;
      this.save();
      for (const cb of this.listeners) {
        try { cb({ revision: this.state.revision }); }
        catch (err) { console.error('reservation listener failed:', err); }
      }
    }
    return result;
  }

  book(rid, input, opts = {}) {
    return this.commit(rid, s => book(s, input, {
      tables: this.tables(),
      seatedWalkIns: seatedWalkInCount(s, { now: opts.now }),
      ...opts
    }));
  }

  /** Change a booking still to come, checked against the same tables and walk-ins as taking it was (lib/reservations.js). */
  updateBooking(rid, id, patch, opts = {}) {
    return this.commit(rid, s => updateBooking(s, id, patch, { tables: this.tables(), seatedWalkIns: seatedWalkInCount(s, { now: opts.now }), ...opts }));
  }

  updateWalkIn(rid, id, patch, opts) { return this.commit(rid, s => updateWalkIn(s, id, patch, opts)); }

  setReservationStatus(rid, id, status, opts) { return this.commit(rid, s => setReservationStatus(s, id, status, opts)); }
  markReminded(rid, id, opts) { return this.commit(rid, s => markReminded(s, id, opts)); }
  unmarkReminded(rid, id) { return this.commit(rid, s => unmarkReminded(s, id)); }
  /** Bookings whose guest should be reminded now (lib/reservations.js). */
  remindersDue(rid, opts) { return remindersDue(this.stateFor(rid), opts); }
  giveReward(rid, id, scheme, opts) { return this.commit(rid, s => giveReward(s, id, scheme, opts)); }
  takeBackReward(rid, id) { return this.commit(rid, s => takeBackReward(s, id)); }
  giveWalkInReward(rid, id, scheme, opts) { return this.commit(rid, s => giveWalkInReward(s, id, scheme, opts)); }
  takeBackWalkInReward(rid, id) { return this.commit(rid, s => takeBackWalkInReward(s, id)); }
  /** Whether this booking or walk-in earns the reward under the scheme (lib/loyalty.js). */
  rewardDue(rid, reservation, scheme) { return rewardDue(this.stateFor(rid), reservation, scheme); }
  addWalkIn(rid, input, opts) { return this.commit(rid, s => addWalkIn(s, input, opts)); }

  // Guests' requests for a table, collected from the cloud (lib/bookingRequests.js). Accepting one books it through the same check as any
  // booking, against the same tables and the same walk-ins already sitting down.
  receiveRequests(rid, rows, opts) { return this.commit(rid, s => receiveRequests(s, rows, opts)); }
  settleLapsed(rid, opts) { return this.commit(rid, s => settleLapsed(s, opts)); }
  pruneDecided(rid, opts) { return this.commit(rid, s => pruneDecided(s, opts)); }
  declineRequest(rid, id, opts) { return this.commit(rid, s => declineRequest(s, id, opts)); }
  acceptRequest(rid, id, opts = {}) {
    return this.commit(rid, s => acceptRequest(s, id, { tables: this.tables(), seatedWalkIns: seatedWalkInCount(s, { now: opts.now }), ...opts }));
  }
  pendingRequests(rid, opts) { return pendingRequests(this.stateFor(rid), opts); }
  setWaitlistStatus(rid, id, status, opts) { return this.commit(rid, s => setWaitlistStatus(s, id, status, opts)); }

  /** Whether a time could be booked, without booking it. For the console's "is 8pm free?". */
  availability(rid, params, { now = new Date() } = {}) {
    const s = this.stateFor(rid);
    return availability(s, { ...params, tables: this.tables(), seatedWalkIns: seatedWalkInCount(s, { now }) });
  }

  /** What the console shows: one day's bookings, who is queueing, and the counts. */
  snapshot(rid, day, { now = new Date() } = {}) {
    const s = this.stateFor(rid);
    return {
      restaurant_id: s.restaurant_id,
      revision: s.revision,
      day,
      reservations: bookingsOn(s, day),
      waitlist: queue(s),
      summary: summarize(s, day, { now })
    };
  }

  /** Everything, for the cloud copy. */
  all(rid) {
    const s = this.stateFor(rid);
    return { reservations: s.reservations, waitlist: s.waitlist, revision: s.revision };
  }

  replaceAll(restaurantId, state) {
    this.state = normalizeState({ ...state, restaurant_id: restaurantId }, restaurantId);
    this.save();
    return this.state;
  }

  isEmpty() { return this.state.reservations.length === 0 && this.state.waitlist.length === 0; }
}

export const reservationStore = new ReservationStore();
