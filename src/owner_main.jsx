import React from 'react';
import ReactDOM from 'react-dom/client';
import { OwnerApp } from './owner/OwnerApp';
import { createOwnerClient } from './owner/lib/client';
import './index.css';
import './admin/admin.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <OwnerApp client={createOwnerClient()} />
  </React.StrictMode>
);
