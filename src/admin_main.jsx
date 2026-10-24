import React from 'react';
import ReactDOM from 'react-dom/client';
import { AdminApp } from './admin/AdminApp';
import './index.css';
import './admin/admin.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>
);
