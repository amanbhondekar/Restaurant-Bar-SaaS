import express from 'express';

import { readPage, enablePage, disablePage, newAddress } from './bookingInbox.js';
import { CLOUD_DOWN, withinMs } from './bookingInboxRunner.js';

// The screen's way to the public booking page (§4.6): see where it stands, switch it on or off, give it a new address. Thin by design: the
// cloud does the work (lib/bookingInbox.js) and the operator service serves the page.
//
// Reception only. The cloud is the truth about the page, and the hub remembers what it last saw so the screen still says something with the
// internet down. The address is the operator service's, with the page's code on the end, which is why a page cannot be switched ON without one.

const CLOUD_BUT_UNREACHED = 'The hub could not reach the cloud, so this is what it knew last.';

/** What the hub last saw of its page, kept in its own config beside everything else it remembers (`config` is the hub's config store). */
export const pageMemory = config => ({
  get: () => config.getPairingInfo().booking_page || null,
  set: page => config.saveConfig({ ...config.getPairingInfo(), booking_page: page ? { code: page.code, enabled: page.enabled } : null })
});

/**
 * `cloudSession()` is the hub's own cloud session (`{ rid, client }`) or null; `operatorUrl()` the operator service's address or null;
 * `memory` is `{ get(), set(page) }` for what the hub last saw. `pageOps` and the two waits are parameters so tests can stand in for the cloud.
 */
export function bookingPageRoutes({ guard, cloudSession, operatorUrl, memory, pageOps = { readPage, enablePage, disablePage, newAddress }, readMs = 4000, changeMs = 15000 }) {
  const router = express.Router();

  const view = (page, { reachable, message } = {}) => {
    const base = operatorUrl();
    return {
      success: true,
      configured: Boolean(base),
      enabled: Boolean(page?.enabled),
      code: page?.code ?? null,
      url: base && page?.code ? `${base}/book/${page.code}` : null,
      ...(page?.code && !base ? { needs_operator_url: true } : {}),
      reachable,
      ...(message ? { message } : {})
    };
  };

  router.get('/admin/booking-page', guard, async (req, res) => {
    const cloud = await cloudSession();
    const read = cloud ? await withinMs(pageOps.readPage(cloud.client, cloud.rid), readMs) : null;
    if (read?.ok) {
      memory.set(read.page);
      return res.json(view(read.page, { reachable: true }));
    }
    return res.json(view(memory.get(), { reachable: false, message: CLOUD_BUT_UNREACHED }));
  });

  /** A change to the page: needs the cloud, so says plainly when there is none, or when it will not answer. */
  async function change(res, make) {
    const cloud = await cloudSession();
    if (!cloud) return res.status(503).json(CLOUD_DOWN);
    const result = await withinMs(make(cloud), changeMs);
    if (!result) return res.status(503).json(CLOUD_DOWN);
    if (!result.ok) return res.status(result.code === 'NO_PAGE' ? 404 : 503).json({ success: false, code: result.code, error: result.error });
    memory.set(result.page);
    return res.json(view(result.page, { reachable: true }));
  }

  router.put('/admin/booking-page', guard, (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, code: 'INVALID', error: 'Say whether the page should be on or off.' });
    if (enabled && !operatorUrl()) {
      return res.status(409).json({ success: false, code: 'NOT_CONFIGURED', error: 'Online booking is served by the operator service. Set OPERATOR_SERVICE_URL on this hub first.' });
    }
    return change(res, c => (enabled ? pageOps.enablePage(c.client, c.rid) : pageOps.disablePage(c.client, c.rid)));
  });

  router.post('/admin/booking-page/new-address', guard, (req, res) => change(res, c => pageOps.newAddress(c.client, c.rid)));

  return router;
}
