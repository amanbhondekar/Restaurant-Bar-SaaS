// What the page says about the cloud copy of one catalog, from the hub's /admin/sync-status answer.
// `status` is `{ revision, synced_revision, pending_revision, failed }` for that catalog, `online` the
// hub's own view of its internet connection. Returns `{ state, label }`, or null when there is nothing
// to say (no answer yet, or the catalog was never edited on the hub, so the cloud already matches it).

export function cloudState(status, online = true) {
  if (!status || !Number.isInteger(status.revision)) return null;
  if (status.revision === 0) return null;
  if (status.failed) return { state: 'failed', label: 'Cloud: not saved' };
  if (status.synced_revision >= status.revision) return { state: 'synced', label: 'Cloud: synced' };
  if (status.pending_revision !== null && status.pending_revision !== undefined) {
    return { state: 'pending', label: online ? 'Cloud: saving…' : 'Cloud: waiting for internet' };
  }
  // Edited on the hub, but nothing is queued and the cloud is behind: the push was dropped.
  return { state: 'failed', label: 'Cloud: not saved' };
}
