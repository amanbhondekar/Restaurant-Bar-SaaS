import express from 'express';

// The reception laptop's way to the subscription (§4.4): see where it stands, start one, change its plan, cancel it. Thin by
// design. The hub forwards to the operator service (lib/billingClient.js) and reports; every decision is the service's.
//
// Behind `guard` (reception only): the person at the reception laptop is who the owner is in this product, and a waiter's handset
// must not be able to put the restaurant on a plan or take it off one.
//
// Only the plan name is ever forwarded from a request body. Which restaurant it is comes from the hub's own cloud sign-in, not from
// anything a screen could be made to send.

/** Reasons the service could not be asked, for which the screen still loads and says so (rather than failing as a whole). */
const UNREACHABLE = new Set(['OFFLINE', 'NO_CLOUD_SESSION', 'BILLING_UNAVAILABLE']);

export function billingRoutes({ client, guard, refreshPlan = async () => {}, refreshTimeoutMs = 4000 }) {
  const router = express.Router();

  const notConnected = res => res.status(503).json({ success: false, code: 'BILLING_NOT_CONFIGURED', error: 'Online billing is not connected on this hub.' });
  const answer = (res, result, okStatus) => (result.ok
    ? res.status(result.status ?? okStatus).json({ ...result.data, success: true })
    : res.status(result.status || 502).json({ success: false, code: result.code, error: result.error }));

  // The plan is re-read from the cloud, when asked, before answering: after the owner pays, the webhook updates the cloud and
  // the hub would otherwise wait for its next scheduled check. Fail-soft and time-boxed: a cloud that is slow or down must not
  // stop the screen from loading.
  const refreshed = async () => {
    try {
      await Promise.race([Promise.resolve().then(refreshPlan), new Promise(resolve => setTimeout(resolve, refreshTimeoutMs).unref?.())]);
    } catch { /* the last synced plan stands */ }
  };

  router.get('/admin/billing', guard, async (req, res) => {
    if (!client.configured()) return res.json({ success: true, configured: false });
    if (req.query.refresh === '1') await refreshed();
    const result = await client.current();
    if (result.ok) return res.json({ ...result.data, success: true, configured: true, reachable: true });
    if (UNREACHABLE.has(result.code)) return res.json({ success: true, configured: true, reachable: false, reason: result.code, message: result.error });
    return answer(res, result);
  });

  const plan = req => (typeof req.body?.plan === 'string' ? req.body.plan : '');

  router.post('/admin/billing/subscribe', guard, async (req, res) => {
    if (!client.configured()) return notConnected(res);
    answer(res, await client.subscribe(plan(req)), 201);
  });

  router.post('/admin/billing/change-plan', guard, async (req, res) => {
    if (!client.configured()) return notConnected(res);
    answer(res, await client.changePlan(plan(req)), 200);
  });

  router.post('/admin/billing/cancel', guard, async (req, res) => {
    if (!client.configured()) return notConnected(res);
    answer(res, await client.cancel(), 200);
  });

  return router;
}
