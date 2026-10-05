import React, { useCallback, useEffect, useState } from 'react';
import { ChefHat } from 'lucide-react';
import { cn } from 'cn';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button, buttonVariants } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { explainError, hubBase, hubGet, hubSend } from './api';
import { cloudState } from './lib/cloudStatus';
import { Notice } from './ui';
import { MenuTab } from './MenuTab';
import { TablesTab } from './TablesTab';
import { CashTab } from './CashTab';
import { PrintersTab } from './PrintersTab';

// The reception laptop's Menu & Tables page. It reads the menu, the table layout and the live table
// states from the hub, hands them to the two tabs, and shows one "Saved on hub" indicator. Every
// write goes through the tabs and is followed by a fresh read, so what is on screen is what the hub has.

function useCatalog() {
  const [menu, setMenu] = useState(null);
  const [layout, setLayout] = useState(null);
  const [live, setLive] = useState(null);
  const [menuError, setMenuError] = useState(null);
  const [layoutError, setLayoutError] = useState(null);
  const [hubName, setHubName] = useState('');

  const loadMenu = useCallback(async () => {
    try {
      const data = await hubGet('/menu');
      setMenu(data);
      setMenuError(null);
      return data;
    } catch (error) {
      setMenuError(error);
      return null;
    }
  }, []);

  // The layout and the live table states travel together: the layout is what gets edited, the
  // live states say which tables have an open bill (those cannot be renamed or deleted).
  const loadLayout = useCallback(async () => {
    try {
      const [nextLayout, nextLive] = await Promise.all([hubGet('/tables/layout'), hubGet('/tables')]);
      setLayout(nextLayout);
      setLive(nextLive);
      setLayoutError(null);
      return nextLayout;
    } catch (error) {
      setLayoutError(error);
      return null;
    }
  }, []);

  const loadLive = useCallback(async () => {
    try {
      setLive(await hubGet('/tables'));
    } catch {
      // keep the last known states; the next full load reports a real outage
    }
  }, []);

  useEffect(() => {
    loadMenu();
    loadLayout();
    hubGet('/pairing-info').then(info => setHubName(info?.name || ''), () => {});
  }, [loadMenu, loadLayout]);

  return { menu, layout, live, menuError, layoutError, hubName, loadMenu, loadLayout, loadLive };
}

function StatusPill({ revision, offline }) {
  const tone = offline ? 'rust' : 'green';
  return (
    <span
      className="inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium"
      style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` }}
      title="Every change is saved on the hub straight away."
    >
      <span className="size-2 rounded-full bg-current" aria-hidden="true" />
      {offline ? 'Hub not reachable' : revision === undefined ? 'Connecting to the hub…' : `Saved on hub · revision ${revision}`}
    </span>
  );
}

// The hub pushes every edit to the cloud in the background; this follows how far it has got. A local
// call, so it simply polls (and again right after the page is looked at or an edit lands).
function useCloudStatus() {
  const [status, setStatus] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await hubGet('/admin/sync-status'));
    } catch {
      // the hub's own outage is reported by the main loads; keep the last answer
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { status, refresh };
}

const CLOUD_TONE = { synced: 'green', pending: 'amber', failed: 'rust' };

function CloudPill({ state, onRetry }) {
  if (!state) return null;
  const tone = CLOUD_TONE[state.state];
  return (
    <span
      className="inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium"
      style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-text)`, borderColor: `var(--status-${tone}-border)` }}
      title="The hub keeps its own copy and sends changes to the cloud whenever it has internet."
    >
      <span className="size-2 rounded-full bg-current" aria-hidden="true" />
      {state.label}
      {state.state === 'failed' && (
        <button type="button" className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2" onClick={onRetry}>
          Retry
        </button>
      )}
    </span>
  );
}

export const AdminApp = () => {
  const catalog = useCatalog();
  const cloud = useCloudStatus();
  const [tab, setTab] = useState('menu');
  const [toast, setToast] = useState(null);
  const [stale, setStale] = useState(null); // 'menu' | 'layout' | null: a write found the hub ahead of the page
  const [epoch, setEpoch] = useState(0); // bumping it remounts the tabs, discarding open editors and drafts
  const { menu, layout, live, loadMenu, loadLayout, loadLive } = catalog;

  const notify = useCallback((message, tone = 'success') => setToast({ message, tone }), []);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Table states change while the page is open (orders come in); look again when the laptop comes back to it.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') loadLive(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [loadLive]);

  const reloadAll = useCallback(async () => {
    setStale(null);
    await Promise.all([loadMenu(), loadLayout()]);
    setEpoch(n => n + 1);
  }, [loadMenu, loadLayout]);

  const onTabChange = value => {
    setTab(value);
    if (value === 'tables') loadLive();
  };

  const revision = tab === 'menu' ? menu?.revision : layout?.revision;
  const offline = Boolean(catalog.menuError && catalog.layoutError && !menu && !layout);
  const cloudStatus = cloud.status && (tab === 'menu' ? cloud.status.menu : cloud.status.tables);
  const cloudNow = offline ? null : cloudState(cloudStatus, cloud.status?.online !== false);

  const retryCloud = async () => {
    try {
      await hubSend('POST', '/admin/sync/retry');
    } catch (error) {
      notify(explainError(error), 'error');
    }
    cloud.refresh();
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}>
              <ChefHat size={20} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="typography-display-sm truncate" style={{ color: 'var(--color-ink)' }}>{catalog.hubName || 'Restaurant'}</h1>
              <p className="text-xs text-muted-foreground">Reception</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* The saved-revision and cloud pills describe the menu and table catalog only. */}
            {(tab === 'menu' || tab === 'tables') && <StatusPill revision={revision} offline={offline} />}
            {(tab === 'menu' || tab === 'tables') && <CloudPill state={cloudNow} onRetry={retryCloud} />}
            <a href={`${hubBase()}/`} className={cn(buttonVariants({ variant: 'outline' }), 'h-10')}>Kitchen display</a>
            <ThemeToggle className="size-10" />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-4 sm:px-6">
        {stale && (
          <Notice
            tone="warning"
            title={stale === 'menu' ? 'The menu changed somewhere else' : 'The table layout changed somewhere else'}
            action={<Button className="h-10" onClick={reloadAll}>Reload</Button>}
          >
            Another screen or an import saved changes after you opened this page, so this one is out of date. Reload to see the latest; edits you have not saved are lost.
          </Notice>
        )}

        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList className="group-data-horizontal/tabs:h-11">
            <TabsTrigger value="menu" className="px-5">Menu</TabsTrigger>
            <TabsTrigger value="tables" className="px-5">Tables</TabsTrigger>
            <TabsTrigger value="cash" className="px-5">Cash &amp; payments</TabsTrigger>
            <TabsTrigger value="printers" className="px-5">Printers</TabsTrigger>
          </TabsList>
          <TabsContent value="menu" keepMounted className="pt-2">
            <MenuTab
              key={`menu-${epoch}`}
              menu={menu}
              error={catalog.menuError}
              onRetry={loadMenu}
              onReload={loadMenu}
              onStale={() => setStale('menu')}
              notify={notify}
            />
          </TabsContent>
          <TabsContent value="tables" keepMounted className="pt-2">
            <TablesTab
              key={`tables-${epoch}`}
              layout={layout}
              live={live}
              error={catalog.layoutError}
              onRetry={loadLayout}
              onReload={loadLayout}
              onRefreshLive={loadLive}
              onStale={() => setStale('layout')}
              notify={notify}
            />
          </TabsContent>
          {/* These two load on demand (default unmounted), so opening the page stays as light as before. */}
          <TabsContent value="cash" className="pt-2">
            <CashTab notify={notify} />
          </TabsContent>
          <TabsContent value="printers" className="pt-2">
            <PrintersTab notify={notify} />
          </TabsContent>
        </Tabs>
      </main>

      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex justify-center px-4" aria-live="polite">
        {toast && <Notice tone={toast.tone} className="pointer-events-auto shadow-lg">{toast.message}</Notice>}
      </div>
    </div>
  );
};
