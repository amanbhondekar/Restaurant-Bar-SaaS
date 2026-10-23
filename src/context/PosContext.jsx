import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  DEMO_RESTAURANTS,
  INITIAL_MENU,
  INITIAL_TABLES,
  INITIAL_TICKETS,
  INITIAL_STAFF,
  loadStoredData,
  saveStoredData
} from '../services/db';
import { lanBus } from '../services/lanBus';
import { playKitchenChime, processCloudSync } from '../services/supabaseSync';
import { authFetch } from '../services/hubAuth';

const PosContext = createContext(null);

export const PosProvider = ({ children }) => {
  // Multi-Tenant Hierarchy State
  const [restaurants, setRestaurants] = useState(() => loadStoredData('restaurants', DEMO_RESTAURANTS));
  const [currentRestaurantId, setCurrentRestaurantId] = useState(() => loadStoredData('current_restaurant_id', 'rest_mejwani'));
  const [currentRole, setCurrentRole] = useState('owner'); // 'owner' | 'manager' | 'waiter'

  // Per-tenant Isolated Datasets
  const [allTables, setAllTables] = useState(() => loadStoredData('all_tables', INITIAL_TABLES));
  const [allMenu, setAllMenu] = useState(() => loadStoredData('all_menu', INITIAL_MENU));
  const [allTickets, setAllTickets] = useState(() => loadStoredData('all_tickets', INITIAL_TICKETS));
  const [allStaff, setAllStaff] = useState(() => loadStoredData('all_staff', INITIAL_STAFF));
  const [allCloudQueues, setAllCloudQueues] = useState(() => loadStoredData('all_cloud_queues', {}));

  // Network & System States
  const [cloudOnline, setCloudOnline] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [deviceMode, setDeviceMode] = useState('dual_demo'); // 'waiter_mobile' | 'laptop_server' | 'dual_demo'
  const [selectedSection, setSelectedSection] = useState('All');
  const [nextTicketId, setNextTicketId] = useState(301);

  // Device Pairing State per handset
  const [pairingState, setPairingState] = useState(() => loadStoredData('pairing_state', {
    pairedRestaurantId: 'rest_mejwani',
    pairedCode: 'MJW-7492',
    isPaired: true
  }));

  // Current active restaurant derived object
  const currentRestaurant = restaurants.find(r => r.id === currentRestaurantId) || restaurants[0];

  // Sync LAN Bus tenant scope whenever active restaurant changes
  useEffect(() => {
    lanBus.setTenantContext(currentRestaurantId, currentRestaurant?.pairingCode);
  }, [currentRestaurantId, currentRestaurant]);

  // Persist State
  useEffect(() => saveStoredData('restaurants', restaurants), [restaurants]);
  useEffect(() => saveStoredData('current_restaurant_id', currentRestaurantId), [currentRestaurantId]);
  useEffect(() => saveStoredData('all_tables', allTables), [allTables]);
  useEffect(() => saveStoredData('all_menu', allMenu), [allMenu]);
  useEffect(() => saveStoredData('all_tickets', allTickets), [allTickets]);
  useEffect(() => saveStoredData('all_staff', allStaff), [allStaff]);
  useEffect(() => saveStoredData('all_cloud_queues', allCloudQueues), [allCloudQueues]);
  useEffect(() => saveStoredData('pairing_state', pairingState), [pairingState]);

  // Current Tenant Scoped Data
  const tables = allTables[currentRestaurantId] || [];
  const menu = allMenu[currentRestaurantId] || [];
  const tickets = allTickets[currentRestaurantId] || [];
  const staff = allStaff[currentRestaurantId] || [];
  const cloudQueue = allCloudQueues[currentRestaurantId] || [];

  // Subscription Plan Module Access Verification
  const hasModuleAccess = (moduleName) => {
    const plan = currentRestaurant?.plan || 'starter';
    if (plan === 'enterprise') return true;
    if (plan === 'pro') {
      return ['core', 'floor', 'kds', 'rapid_order', 'admin', 'waitlist', 'analytics'].includes(moduleName);
    }
    // 'starter' plan tier
    return ['core', 'floor', 'kds', 'rapid_order', 'admin'].includes(moduleName);
  };

  // Change Plan Tier dynamically for testing
  const changeRestaurantPlan = (restId, newPlan) => {
    setRestaurants(prev => prev.map(r => r.id === restId ? { ...r, plan: newPlan } : r));
  };

  // Subscribe to LAN Direct Network Events
  useEffect(() => {
    const unsubscribe = lanBus.subscribe((event) => {
      const { type, payload, restaurantId } = event;
      if (!restaurantId || restaurantId !== currentRestaurantId) return;

      switch (type) {
        case 'NEW_ORDER': {
          setAllTickets(prev => {
            const currentList = prev[restaurantId] || [];
            if (currentList.some(t => t.id === payload.id)) return prev;
            playKitchenChime();
            return { ...prev, [restaurantId]: [payload, ...currentList] };
          });

          setAllTables(prev => {
            const currentTableList = prev[restaurantId] || [];
            const updated = currentTableList.map(t => t.id === payload.tableId ? {
              ...t,
              status: 'kot',
              occupiedSince: t.occupiedSince || new Date().toISOString(),
              activeOrderTotal: (t.activeOrderTotal || 0) + payload.items.reduce((sum, i) => sum + i.price * i.qty, 0)
            } : t);
            return { ...prev, [restaurantId]: updated };
          });
          break;
        }

        case 'TICKET_READY': {
          setAllTickets(prev => {
            const list = prev[restaurantId] || [];
            return { ...prev, [restaurantId]: list.map(t => t.id === payload.ticketId ? { ...t, status: 'ready' } : t) };
          });
          setAllTables(prev => {
            const list = prev[restaurantId] || [];
            return { ...prev, [restaurantId]: list.map(t => t.id === payload.tableId ? { ...t, status: 'ready' } : t) };
          });
          break;
        }

        case 'CLEAR_TABLE': {
          setAllTables(prev => {
            const list = prev[restaurantId] || [];
            return {
              ...prev,
              [restaurantId]: list.map(t => t.id === payload.tableId ? {
                ...t,
                status: 'available',
                occupiedSince: null,
                activeOrderTotal: 0
              } : t)
            };
          });
          break;
        }

        case 'UPDATE_MENU': {
          setAllMenu(prev => ({ ...prev, [restaurantId]: payload }));
          break;
        }

        case 'UPDATE_TABLES': {
          setAllTables(prev => ({ ...prev, [restaurantId]: payload }));
          break;
        }

        default:
          break;
      }
    });

    return unsubscribe;
  }, [currentRestaurantId]);

  // Hub Server Status & Active Ticket Synchronizer
  const [hubStatus, setHubStatus] = useState({ queued: 0, online: true, isHubConnected: false });
  const [isMenuUninitialized, setIsMenuUninitialized] = useState(false);

  // 1. Fetch active tickets, menu, and tables from Hub Server on load/connect
  useEffect(() => {
    const fetchHubData = async () => {
      const hostname = typeof window !== 'undefined' ? (window.location.hostname || 'localhost') : 'localhost';
      const hubBaseUrl = `http://${hostname}:4000`;

      try {
        const [activeRes, statusRes, menuRes, tablesLayoutRes] = await Promise.all([
          authFetch(`${hubBaseUrl}/orders/active`).catch(() => null),
          authFetch(`${hubBaseUrl}/sync-status`).catch(() => null),
          authFetch(`${hubBaseUrl}/menu`).catch(() => null),
          authFetch(`${hubBaseUrl}/tables/layout`).catch(() => null)
        ]);

        if (activeRes && activeRes.ok) {
          const activeData = await activeRes.json();
          if (activeData && activeData.tickets && Array.isArray(activeData.tickets)) {
            const formattedTickets = activeData.tickets.map(t => ({
              id: t.id,
              ticket_number: t.ticket_number,
              restaurantId: t.restaurant_id || currentRestaurantId,
              tableId: t.table_id || 1,
              tableName: t.table_name || 'T1',
              items: t.items || [],
              time: t.created_at,
              status: t.status,
              synced: t.synced_to_cloud,
              note: t.note || ''
            }));

            setAllTickets(prev => ({
              ...prev,
              [currentRestaurantId]: formattedTickets
            }));
          }
        }

        if (menuRes && menuRes.ok) {
          const menuData = await menuRes.json();
          if (menuData.uninitialized) {
            setIsMenuUninitialized(true);
          } else if (menuData.items && Array.isArray(menuData.items)) {
            setIsMenuUninitialized(false);
            setAllMenu(prev => ({
              ...prev,
              [currentRestaurantId]: menuData.items
            }));
          }
        }

        if (tablesLayoutRes && tablesLayoutRes.ok) {
          const layoutData = await tablesLayoutRes.json();
          if (layoutData.uninitialized) {
            setIsMenuUninitialized(true);
          } else if (layoutData.tables && Array.isArray(layoutData.tables)) {
            setAllTables(prev => {
              const currentList = prev[currentRestaurantId] || [];
              const updated = layoutData.tables.map(t => {
                const existing = currentList.find(c => String(c.id) === String(t.id));
                return {
                  ...t,
                  status: existing?.status || 'available',
                  occupiedSince: existing?.occupiedSince || null,
                  activeOrderTotal: existing?.activeOrderTotal || 0
                };
              });
              return { ...prev, [currentRestaurantId]: updated };
            });
          }
        }

        if (statusRes && statusRes.ok) {
          const statusData = await statusRes.json();
          setHubStatus({
            queued: statusData.queued || 0,
            online: Boolean(statusData.online),
            isHubConnected: true,
            pairing: statusData.pairing
          });
        } else {
          setHubStatus(prev => ({ ...prev, isHubConnected: false }));
        }
      } catch (err) {
        setHubStatus(prev => ({ ...prev, isHubConnected: false }));
      }
    };

    fetchHubData();
    const interval = setInterval(fetchHubData, 4000);
    return () => clearInterval(interval);
  }, [currentRestaurantId]);

  // Outage Simulator Toggle per tenant
  const toggleCloudOutage = async () => {
    const hostname = typeof window !== 'undefined' ? (window.location.hostname || 'localhost') : 'localhost';
    try {
      const res = await authFetch(`http://${hostname}:4000/toggle-outage`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setCloudOnline(data.online);
        return;
      }
    } catch (err) {}

    if (cloudOnline) {
      setCloudOnline(false);
    } else {
      setCloudOnline(true);
      if (cloudQueue.length > 0) {
        setIsSyncing(true);
        processCloudSync(
          cloudQueue,
          (syncedId, remainingQueue) => {
            setAllTickets(prev => ({
              ...prev,
              [currentRestaurantId]: (prev[currentRestaurantId] || []).map(t => t.id === syncedId ? { ...t, synced: true } : t)
            }));
            setAllCloudQueues(prev => ({ ...prev, [currentRestaurantId]: remainingQueue }));
          },
          (syncedIds) => {
            setAllTickets(prev => ({
              ...prev,
              [currentRestaurantId]: (prev[currentRestaurantId] || []).map(t => syncedIds.includes(t.id) ? { ...t, synced: true } : t)
            }));
            setAllCloudQueues(prev => ({ ...prev, [currentRestaurantId]: [] }));
            setIsSyncing(false);
          }
        );
      }
    }
  };

  // Dispatch Order to Kitchen (Instant LAN path scoped per restaurant)
  const sendOrderToKitchen = async (tableId, items, note = '') => {
    const table = tables.find(t => t.id === tableId);
    if (!table || !items.length) return null;

    const hostname = typeof window !== 'undefined' ? (window.location.hostname || 'localhost') : 'localhost';
    const hubBaseUrl = `http://${hostname}:4000`;

    const orderPayload = {
      table_id: table.id,
      table_name: table.name,
      items,
      note,
      created_by_waiter: 'Waiter Handset'
    };

    // 1. Try sending order to Local Hub Server over LAN HTTP endpoint
    try {
      const res = await authFetch(`${hubBaseUrl}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload)
      });

      if (res.ok) {
        const data = await res.json();
        const hubTicket = data.ticket;
        const formattedTicket = {
          id: hubTicket.id,
          ticket_number: hubTicket.ticket_number,
          restaurantId: hubTicket.restaurant_id || currentRestaurantId,
          tableId: hubTicket.table_id || table.id,
          tableName: hubTicket.table_name || table.name,
          items: hubTicket.items,
          time: hubTicket.created_at,
          status: hubTicket.status,
          synced: hubTicket.synced_to_cloud,
          note: hubTicket.note
        };

        setAllTickets(prev => ({
          ...prev,
          [currentRestaurantId]: [formattedTicket, ...(prev[currentRestaurantId] || []).filter(t => t.id !== formattedTicket.id)]
        }));

        setAllTables(prev => {
          const currentTableList = prev[currentRestaurantId] || [];
          const updated = currentTableList.map(t => t.id === table.id ? {
            ...t,
            status: 'kot',
            occupiedSince: t.occupiedSince || new Date().toISOString(),
            activeOrderTotal: (t.activeOrderTotal || 0) + items.reduce((sum, i) => sum + i.price * i.qty, 0)
          } : t);
          return { ...prev, [currentRestaurantId]: updated };
        });

        return formattedTicket;
      }
    } catch (err) {
      console.warn('ℹ️ Hub server HTTP endpoint unreachable, falling back to local bus:', err.message);
    }

    // 2. Fallback to in-browser LAN bus
    const ticketId = nextTicketId;
    setNextTicketId(prev => prev + 1);

    const newTicket = {
      id: ticketId,
      restaurantId: currentRestaurantId,
      tableId: table.id,
      tableName: table.name,
      items,
      time: new Date().toISOString(),
      status: 'in_progress',
      synced: cloudOnline,
      note
    };

    lanBus.publish('NEW_ORDER', newTicket, currentRestaurantId);

    if (!cloudOnline) {
      setAllCloudQueues(prev => ({
        ...prev,
        [currentRestaurantId]: [...(prev[currentRestaurantId] || []), newTicket]
      }));
    } else {
      setTimeout(() => {
        setAllTickets(prev => ({
          ...prev,
          [currentRestaurantId]: (prev[currentRestaurantId] || []).map(t => t.id === ticketId ? { ...t, synced: true } : t)
        }));
      }, 400);
    }

    return newTicket;
  };

  const markTicketReady = async (ticketId) => {
    const ticket = tickets.find(t => t.id === ticketId || String(t.ticket_number) === String(ticketId));
    
    const hostname = typeof window !== 'undefined' ? (window.location.hostname || 'localhost') : 'localhost';
    const hubBaseUrl = `http://${hostname}:4000`;

    try {
      const res = await authFetch(`${hubBaseUrl}/orders/${ticketId}/ready`, { method: 'POST' });
      if (res.ok) {
        setAllTickets(prev => ({
          ...prev,
          [currentRestaurantId]: (prev[currentRestaurantId] || []).map(t => 
            (t.id === ticketId || String(t.ticket_number) === String(ticketId)) ? { ...t, status: 'ready' } : t
          )
        }));
        if (ticket) {
          setAllTables(prev => ({
            ...prev,
            [currentRestaurantId]: (prev[currentRestaurantId] || []).map(t => t.id === ticket.tableId ? { ...t, status: 'ready' } : t)
          }));
        }
        return;
      }
    } catch (err) {}

    if (!ticket) return;
    lanBus.publish('TICKET_READY', { ticketId, tableId: ticket.tableId }, currentRestaurantId);
  };

  const clearTableBill = (tableId) => {
    lanBus.publish('CLEAR_TABLE', { tableId }, currentRestaurantId);
  };

  // Device Pairing Action
  const pairDevice = (restaurantId, code) => {
    const targetRest = restaurants.find(r => r.id === restaurantId || r.pairingCode.toUpperCase() === code.trim().toUpperCase());
    if (targetRest) {
      setPairingState({
        pairedRestaurantId: targetRest.id,
        pairedCode: targetRest.pairingCode,
        isPaired: true
      });
      setCurrentRestaurantId(targetRest.id);
      return { success: true, restaurantName: targetRest.name };
    }
    return { success: false, error: 'Invalid pairing code or restaurant ID' };
  };

  // Self-Serve Restaurant Onboarding
  const onboardNewRestaurant = ({ profile, layout, menuItems, staffMembers }) => {
    const restId = 'rest_' + Date.now();
    const pairingCode = profile.name.substring(0, 3).toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000);

    const newRest = {
      id: restId,
      name: profile.name,
      slug: profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      cuisine: profile.cuisine || 'Multi-Cuisine',
      address: profile.address || 'Main Street',
      city: profile.city || 'Nagpur',
      phone: profile.phone || '+91 90000 00000',
      currency: profile.currency || '₹',
      plan: profile.plan || 'pro',
      pairingCode,
      isPilot: false,
      created: new Date().toISOString()
    };

    // Create Initial Tables
    const createdTables = (layout || []).map((t, idx) => ({
      id: idx + 1,
      name: t.name,
      section: t.section || 'Main Dining',
      capacity: t.capacity || 4,
      status: 'available',
      occupiedSince: null,
      activeOrderTotal: 0
    }));

    // Create Initial Menu Items
    const createdMenu = (menuItems || []).map((m, idx) => ({
      id: 'm_' + (idx + 1),
      name: m.name,
      price: Number(m.price),
      category: m.category || 'General',
      isVeg: Boolean(m.isVeg),
      available: true
    }));

    // Create Initial Staff
    const createdStaff = (staffMembers || []).map((s, idx) => ({
      id: 's_' + (idx + 1),
      name: s.name,
      role: s.role,
      pin: s.pin || '1234'
    }));

    setRestaurants(prev => [...prev, newRest]);
    setAllTables(prev => ({ ...prev, [restId]: createdTables }));
    setAllMenu(prev => ({ ...prev, [restId]: createdMenu }));
    setAllTickets(prev => ({ ...prev, [restId]: [] }));
    setAllStaff(prev => ({ ...prev, [restId]: createdStaff }));

    // Switch to newly created restaurant
    setCurrentRestaurantId(restId);
    setPairingState({
      pairedRestaurantId: restId,
      pairedCode: pairingCode,
      isPaired: true
    });

    return newRest;
  };

  // Admin Menu Operations
  const addMenuItem = (item) => {
    const newItem = { id: 'm_' + Date.now(), available: true, ...item };
    const updated = [...menu, newItem];
    setAllMenu(prev => ({ ...prev, [currentRestaurantId]: updated }));
    lanBus.publish('UPDATE_MENU', updated, currentRestaurantId);
  };

  const updateMenuItem = (updatedItem) => {
    const updated = menu.map(m => m.id === updatedItem.id ? updatedItem : m);
    setAllMenu(prev => ({ ...prev, [currentRestaurantId]: updated }));
    lanBus.publish('UPDATE_MENU', updated, currentRestaurantId);
  };

  const deleteMenuItem = (id) => {
    const updated = menu.filter(m => m.id !== id);
    setAllMenu(prev => ({ ...prev, [currentRestaurantId]: updated }));
    lanBus.publish('UPDATE_MENU', updated, currentRestaurantId);
  };

  // Admin Floor Layout Operations
  const addTable = (table) => {
    const newTable = {
      id: tables.length ? Math.max(...tables.map(t => t.id)) + 1 : 1,
      status: 'available',
      occupiedSince: null,
      activeOrderTotal: 0,
      ...table
    };
    const updated = [...tables, newTable];
    setAllTables(prev => ({ ...prev, [currentRestaurantId]: updated }));
    lanBus.publish('UPDATE_TABLES', updated, currentRestaurantId);
  };

  const updateTable = (updatedTable) => {
    const updated = tables.map(t => t.id === updatedTable.id ? updatedTable : t);
    setAllTables(prev => ({ ...prev, [currentRestaurantId]: updated }));
    lanBus.publish('UPDATE_TABLES', updated, currentRestaurantId);
  };

  const deleteTable = (id) => {
    const updated = tables.filter(t => t.id !== id);
    setAllTables(prev => ({ ...prev, [currentRestaurantId]: updated }));
    lanBus.publish('UPDATE_TABLES', updated, currentRestaurantId);
  };

  return (
    <PosContext.Provider value={{
      restaurants,
      currentRestaurantId,
      setCurrentRestaurantId,
      currentRestaurant,
      currentRole,
      setCurrentRole,
      cloudOnline,
      toggleCloudOutage,
      hubStatus,
      isMenuUninitialized,
      tables,
      menu,
      tickets,
      staff,
      cloudQueue,
      isSyncing,
      deviceMode,
      setDeviceMode,
      selectedSection,
      setSelectedSection,
      pairingState,
      pairDevice,
      hasModuleAccess,
      changeRestaurantPlan,
      onboardNewRestaurant,
      sendOrderToKitchen,
      submitOrder: sendOrderToKitchen,
      markTicketReady,
      clearTableBill,
      addMenuItem,
      updateMenuItem,
      deleteMenuItem,
      addTable,
      updateTable,
      deleteTable,
    }}>
      {children}
    </PosContext.Provider>
  );
};

export const usePos = () => useContext(PosContext);
