// Cloud Data Service — Remote SaaS Mode
// Provides direct Supabase queries & Realtime listeners for remote owners/managers
// when accessing the dashboard outside the restaurant's local LAN network.

import { supabase } from './supabaseSync';

export const isCloudConfigured = () => {
  const url = import.meta.env.VITE_SUPABASE_URL || '';
  return Boolean(url && !url.includes('example.supabase.co'));
};

export const fetchCloudDashboardData = async (restaurantId = '11111111-1111-1111-1111-111111111111') => {
  if (!isCloudConfigured()) {
    return { ok: false, error: 'Supabase URL not configured for cloud remote mode' };
  }

  try {
    // 1. Fetch restaurant profile
    const { data: restaurant } = await supabase
      .from('restaurants')
      .select('id, name, city, currency, plan')
      .eq('id', restaurantId)
      .maybeSingle();

    // 2. Fetch tables
    const { data: dbTables, error: tablesErr } = await supabase
      .from('tables')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('id', { ascending: true });

    // 3. Fetch recent orders (active + today's billed)
    const { data: dbOrders, error: ordersErr } = await supabase
      .from('orders')
      .select('id, ticket_number, table_name, table_id, status, total_amount, note, created_by_waiter, created_at, updated_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
      .limit(60);

    if (ordersErr || tablesErr) {
      return { ok: false, error: ordersErr?.message || tablesErr?.message };
    }

    const allOrders = dbOrders || [];
    const activeTickets = allOrders.filter(o => o.status === 'in_progress' || o.status === 'ready');
    const completedTickets = allOrders.filter(o => o.status === 'billed' || o.status === 'completed');

    const runningTotal = allOrders.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);

    // Derive table status map based on active tickets
    const activeTableSet = new Map();
    activeTickets.forEach(t => {
      const key = t.table_name || `T${t.table_id}`;
      activeTableSet.set(key, t.status);
    });

    const tables = (dbTables || []).map(tbl => ({
      id: tbl.id,
      name: tbl.name,
      section: tbl.section || 'Main Hall',
      capacity: tbl.capacity || 4,
      status: activeTableSet.get(tbl.name) || tbl.status || 'available',
      activeOrderTotal: activeTickets
        .filter(t => t.table_name === tbl.name || t.table_id === tbl.id)
        .reduce((s, t) => s + (Number(t.total_amount) || 0), 0)
    }));

    return {
      ok: true,
      data: {
        restaurant: restaurant || {
          id: restaurantId,
          name: 'Hotel Mejwani (Cloud Remote)',
          city: 'Nagpur',
          currency: '₹'
        },
        tables,
        active_tickets: activeTickets,
        completed_tickets: completedTickets,
        sync_status: {
          online: true,
          queued: 0,
          isSyncing: false,
          last_synced_at: new Date().toISOString()
        },
        running_total: runningTotal,
        connected_devices: 1,
        mode: 'cloud'
      }
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to fetch cloud dashboard data' };
  }
};

export const subscribeCloudRealtime = (restaurantId, onUpdate) => {
  if (!isCloudConfigured()) return () => {};

  try {
    const channel = supabase
      .channel(`cloud-dash-${restaurantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        onUpdate();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, () => {
        onUpdate();
      })
      .subscribe();

    return () => {
      try { supabase.removeChannel(channel); } catch (e) {}
    };
  } catch (e) {
    return () => {};
  }
};
