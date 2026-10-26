import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { AdminApp } from './AdminApp';
import { ConfigProblem } from './screens/ConfigProblem';
import { createAdminApi } from './lib/api';
import { createAuth, createAuthClient } from './lib/auth';
import { readConfig } from './lib/config';

// Light or dark as the viewer's system is set. (The product's other pages do this in an inline script, which this page is not allowed to have.)
try {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.add(dark ? 'dark' : 'light');
} catch { /* the page is light, which is fine */ }

const root = ReactDOM.createRoot(document.getElementById('root'));
const settings = readConfig(import.meta.env);

if (!settings.ok) {
  root.render(<ConfigProblem problems={settings.problems} />);
} else {
  const auth = createAuth(createAuthClient(settings.config));
  const api = createAdminApi({ baseUrl: settings.config.apiUrl, getToken: () => auth.token() });
  root.render(
    <React.StrictMode>
      <AdminApp auth={auth} api={api} />
    </React.StrictMode>
  );
}
