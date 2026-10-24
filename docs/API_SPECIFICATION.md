# Hub Server API Specification

The Hub Server runs on Node/Express and WebSockets, listening on port `4000` (binding to `0.0.0.0`).

---

## REST Endpoints

### 1. `GET /pairing-info`
Returns identity and network details of the hub server.
- **Response**:
```json
{
  "paired": true,
  "restaurant_id": "11111111-1111-1111-1111-111111111111",
  "name": "Hotel Mejwani",
  "pairing_code": "MJW-7492",
  "lan_ip": "192.168.1.50",
  "port": 4000,
  "server_url": "http://192.168.1.50:4000",
  "ws_url": "ws://192.168.1.50:4000/live"
}
```

---

### 2. `POST /orders`
Submits a new order from a waiter mobile handset.
- **Request Body**:
```json
{
  "table_id": 4,
  "table_name": "T4",
  "items": [
    { "id": "m1", "name": "Mutton Saoji", "qty": 2, "price": 340 }
  ],
  "note": "Extra spicy",
  "created_by_waiter": "Waiter 1"
}
```
- **Response**: `201 Created`
```json
{
  "success": true,
  "message": "Order received by local hub & pushed to kitchen",
  "ticket": {
    "id": "t_1712345678_a1b2",
    "ticket_number": 104,
    "restaurant_id": "11111111-1111-1111-1111-111111111111",
    "table_id": 4,
    "table_name": "T4",
    "items": [...],
    "total_amount": 680,
    "status": "in_progress",
    "synced_to_cloud": false,
    "created_at": "2026-08-17T21:00:00.000Z"
  }
}
```

---

### 3. `GET /orders/active`
Returns all open/active KOT tickets for the kitchen display.
- **Response**: `200 OK`

---

### 4. `POST /orders/:id/ready`
Marks a ticket ready from the kitchen display.
- **Response**: `200 OK`

---

### 5. `GET /tables`
Returns live floor grid table statuses derived from active tickets.
- **Response**: `200 OK`
```json
{
  "restaurant_id": "11111111-1111-1111-1111-111111111111",
  "count": 12,
  "tables": [
    {
      "id": 4,
      "name": "T4",
      "section": "Main Hall",
      "capacity": 4,
      "status": "kot",
      "activeOrderTotal": 680,
      "occupiedSince": "2026-08-17T21:00:00.000Z"
    }
  ]
}
```

---

### 6. `POST /tables/:id/clear`
Clears active tickets for a table after guest payment.
- **Response**: `200 OK`

---

### 7. `GET /sync-status`
Returns background cloud retry queue metrics and online status (`queued`, `quarantined`, `online`, `last_synced_at`, `catalog`, `pairing`), and
`heartbeat: { at, ok }`: whether this hub has told the cloud it is alive (every five minutes; see `docs/OPERATOR_SERVICE.md`). `at` is when the
last report **got through**, and stays put while later ones fail; `ok` is `null` before the first attempt, then whether the latest one worked.

---

## WebSocket Gateway (`ws://<hub-ip>:4000/live`)

Broadcasts real-time events to all connected Kitchen Displays and Waiter Handsets:
- `NEW_ORDER`: Broadcast when a new order is received over LAN.
- `TICKET_READY`: Broadcast when kitchen marks a ticket ready.
- `CLEAR_TABLE`: Broadcast when a table bill is cleared.
- `SYNC_STATUS_CHANGE`: Broadcast when cloud retry queue status updates.
