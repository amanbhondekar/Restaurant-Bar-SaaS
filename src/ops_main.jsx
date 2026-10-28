import React from 'react';
import ReactDOM from 'react-dom/client';
import { OpsApp } from './ops/OpsApp';
import './index.css';

// Light or dark as the operator's system is set. (The product's other pages do this in an inline script, which the console's page is not
// allowed to have.)
try {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.add(dark ? 'dark' : 'light');
} catch { /* the page is light, which is fine */ }

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <OpsApp />
  </React.StrictMode>
);
