// ============================================================
// Multi-Tenant Restaurant Data Store & Initial Seeds
// Supports multiple restaurant tenants with strict data isolation
// ============================================================

export const DEMO_RESTAURANTS = [
  {
    id: 'rest_mejwani',
    name: 'Hotel Mejwani',
    slug: 'hotel-mejwani',
    cuisine: 'Nagpuri Saoji & Indian',
    address: 'Manish Nagar, Wardha Road',
    city: 'Nagpur',
    phone: '+91 98220 12345',
    currency: '₹',
    plan: 'pro', // 'starter' | 'pro' | 'enterprise'
    pairingCode: 'MJW-7492',
    isPilot: true,
    created: '2026-01-10T00:00:00.000Z'
  },
  {
    id: 'rest_spicegarden',
    name: 'Spice Garden Bistro',
    slug: 'spice-garden',
    cuisine: 'North Indian & Continental',
    address: '100ft Road, Indiranagar',
    city: 'Bengaluru',
    phone: '+91 98450 98765',
    currency: '₹',
    plan: 'starter', // 'starter' tier (Waitlist & Analytics gated)
    pairingCode: 'SPG-3108',
    isPilot: false,
    created: '2026-02-01T00:00:00.000Z'
  }
];

export const INITIAL_STAFF = {
  rest_mejwani: [
    { id: 's1', name: 'Rajesh Sharma', role: 'owner', pin: '1234' },
    { id: 's2', name: 'Amit Verma', role: 'manager', pin: '2345' },
    { id: 's3', name: 'Vikram (W1)', role: 'waiter', pin: '1111' },
    { id: 's4', name: 'Sanjay (W2)', role: 'waiter', pin: '2222' }
  ],
  rest_spicegarden: [
    { id: 's10', name: 'Ananya Rao', role: 'owner', pin: '9999' },
    { id: 's11', name: 'Karthik N', role: 'manager', pin: '8888' },
    { id: 's12', name: 'Rohan (W1)', role: 'waiter', pin: '3333' }
  ]
};

export const INITIAL_MENU = {
  rest_mejwani: [
    // Starters
    { id: 'm1',  name: 'Paneer Tikka',        price: 230, category: 'Starters',         isVeg: true,  available: true },
    { id: 'm2',  name: 'Chicken Sukka',        price: 220, category: 'Starters',         isVeg: false, available: true },
    { id: 'm3',  name: 'Veg Manchow Soup',     price: 143, category: 'Starters',         isVeg: true,  available: true },
    { id: 'm4',  name: 'Chicken Lollipop',     price: 240, category: 'Starters',         isVeg: false, available: true },
    // Saoji Specials — Nagpur's Signature Cuisine
    { id: 'm5',  name: 'Mutton Saoji',         price: 340, category: 'Saoji Specials',   isVeg: false, available: true },
    { id: 'm6',  name: 'Chicken Saoji',        price: 280, category: 'Saoji Specials',   isVeg: false, available: true },
    { id: 'm7',  name: 'Paneer Saoji',         price: 320, category: 'Saoji Specials',   isVeg: true,  available: true },
    { id: 'm8',  name: 'Egg Saoji',            price: 200, category: 'Saoji Specials',   isVeg: false, available: true },
    // Biryani & Rice
    { id: 'm9',  name: 'Mutton Biryani',       price: 320, category: 'Biryani & Rice',   isVeg: false, available: true },
    { id: 'm10', name: 'Chicken Biryani',      price: 260, category: 'Biryani & Rice',   isVeg: false, available: true },
    { id: 'm11', name: 'Veg Biryani',          price: 200, category: 'Biryani & Rice',   isVeg: true,  available: true },
    { id: 'm12', name: 'Jeera Rice',           price: 140, category: 'Biryani & Rice',   isVeg: true,  available: true },
    // Main Course & Breads
    { id: 'm13', name: 'Mutton Curry',         price: 300, category: 'Main Course',      isVeg: false, available: true },
    { id: 'm14', name: 'Chicken Masala',       price: 260, category: 'Main Course',      isVeg: false, available: true },
    { id: 'm15', name: 'Veg Kolhapuri',        price: 190, category: 'Main Course',      isVeg: true,  available: true },
    { id: 'm16', name: 'Dal Tadka',            price: 150, category: 'Main Course',      isVeg: true,  available: true },
    { id: 'm19', name: 'Butter Naan',          price: 80,  category: 'Breads',           isVeg: true,  available: true },
    { id: 'm20', name: 'Garlic Naan',          price: 90,  category: 'Breads',           isVeg: true,  available: true },
    { id: 'm23', name: 'Sol Kadhi',            price: 60,  category: 'Beverages',        isVeg: true,  available: true },
  ],
  rest_spicegarden: [
    { id: 'sg1', name: 'Crispy Corn Salt & Pepper', price: 210, category: 'Starters',    isVeg: true,  available: true },
    { id: 'sg2', name: 'Tandoori Murgh (Half)',     price: 290, category: 'Starters',    isVeg: false, available: true },
    { id: 'sg3', name: 'Paneer Butter Masala',       price: 250, category: 'Main Course', isVeg: true,  available: true },
    { id: 'sg4', name: 'Chicken Lababdar',          price: 310, category: 'Main Course', isVeg: false, available: true },
    { id: 'sg5', name: 'Hyderabadi Dum Biryani',    price: 280, category: 'Rice',        isVeg: false, available: true },
    { id: 'sg6', name: 'Butter Roti',               price: 40,  category: 'Breads',      isVeg: true,  available: true },
    { id: 'sg7', name: 'Mango Lassi',               price: 80,  category: 'Beverages',   isVeg: true,  available: true },
  ]
};

export const INITIAL_TABLES = {
  rest_mejwani: [
    { id: 1,  name: 'T1',  section: 'Main Hall',   capacity: 4, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 2,  name: 'T2',  section: 'Main Hall',   capacity: 2, status: 'occupied',  occupiedSince: new Date(Date.now() - 15 * 60000).toISOString(), activeOrderTotal: 680 },
    { id: 3,  name: 'T3',  section: 'Main Hall',   capacity: 4, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 4,  name: 'T4',  section: 'Main Hall',   capacity: 6, status: 'kot',       occupiedSince: new Date(Date.now() - 25 * 60000).toISOString(), activeOrderTotal: 1040 },
    { id: 5,  name: 'T5',  section: 'AC Room',     capacity: 4, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 6,  name: 'T6',  section: 'AC Room',     capacity: 4, status: 'ready',     occupiedSince: new Date(Date.now() - 42 * 60000).toISOString(), activeOrderTotal: 820 },
    { id: 7,  name: 'T7',  section: 'AC Room',     capacity: 2, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 8,  name: 'T8',  section: 'AC Room',     capacity: 6, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 9,  name: 'T9',  section: 'Family Room', capacity: 8, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 10, name: 'T10', section: 'Family Room', capacity: 4, status: 'kot',       occupiedSince: new Date(Date.now() - 12 * 60000).toISOString(), activeOrderTotal: 1140 },
    { id: 11, name: 'T11', section: 'Family Room', capacity: 4, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 12, name: 'T12', section: 'Family Room', capacity: 6, status: 'occupied',  occupiedSince: new Date(Date.now() - 30 * 60000).toISOString(), activeOrderTotal: 560 },
  ],
  rest_spicegarden: [
    { id: 101, name: 'B1', section: 'Bistro Area', capacity: 2, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 102, name: 'B2', section: 'Bistro Area', capacity: 4, status: 'occupied',  occupiedSince: new Date(Date.now() - 10 * 60000).toISOString(), activeOrderTotal: 500 },
    { id: 103, name: 'B3', section: 'Bistro Area', capacity: 4, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
    { id: 104, name: 'G1', section: 'Garden Lawn', capacity: 6, status: 'kot',       occupiedSince: new Date(Date.now() - 18 * 60000).toISOString(), activeOrderTotal: 840 },
    { id: 105, name: 'G2', section: 'Garden Lawn', capacity: 6, status: 'available', occupiedSince: null, activeOrderTotal: 0 },
  ]
};

export const INITIAL_TICKETS = {
  rest_mejwani: [
    {
      id: 101,
      restaurantId: 'rest_mejwani',
      tableId: 4,
      tableName: 'T4',
      items: [
        { id: 'm9',  name: 'Mutton Biryani',  qty: 2, price: 320 },
        { id: 'm5',  name: 'Mutton Saoji',    qty: 1, price: 340 },
        { id: 'm19', name: 'Butter Naan',     qty: 4, price: 80  },
      ],
      time: new Date(Date.now() - 25 * 60000).toISOString(),
      status: 'in_progress',
      synced: true,
      note: 'Extra spicy Saoji masala'
    },
    {
      id: 102,
      restaurantId: 'rest_mejwani',
      tableId: 10,
      tableName: 'T10',
      items: [
        { id: 'm6',  name: 'Chicken Saoji',        qty: 2, price: 280 },
        { id: 'm20', name: 'Garlic Naan',           qty: 3, price: 90  },
        { id: 'm23', name: 'Sol Kadhi',             qty: 2, price: 60  },
        { id: 'm15', name: 'Veg Kolhapuri',         qty: 1, price: 190 },
      ],
      time: new Date(Date.now() - 12 * 60000).toISOString(),
      status: 'in_progress',
      synced: true,
      note: 'Less oil in Kolhapuri'
    }
  ],
  rest_spicegarden: [
    {
      id: 201,
      restaurantId: 'rest_spicegarden',
      tableId: 104,
      tableName: 'G1',
      items: [
        { id: 'sg2', name: 'Tandoori Murgh (Half)', qty: 1, price: 290 },
        { id: 'sg5', name: 'Hyderabadi Dum Biryani', qty: 2, price: 280 },
      ],
      time: new Date(Date.now() - 18 * 60000).toISOString(),
      status: 'in_progress',
      synced: true,
      note: 'Garden seating order'
    }
  ]
};

export const loadStoredData = (key, fallback) => {
  try {
    const data = localStorage.getItem(`mejwani_saas_${key}`);
    return data ? JSON.parse(data) : fallback;
  } catch (e) {
    return fallback;
  }
};

export const saveStoredData = (key, data) => {
  try {
    localStorage.setItem(`mejwani_saas_${key}`, JSON.stringify(data));
  } catch (e) {}
};
