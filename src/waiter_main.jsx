import React from 'react';
import ReactDOM from 'react-dom/client';
import { PosProvider } from './context/PosContext';
import { WaiterApp } from './waiter_mobile/WaiterApp';
import { installCrashReporter } from './services/crashReporter';
import './index.css';

installCrashReporter({ source: 'waiter' });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PosProvider>
      <WaiterApp />
    </PosProvider>
  </React.StrictMode>
);
