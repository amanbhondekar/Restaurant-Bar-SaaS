import React from 'react';
import { PosProvider, usePos } from './context/PosContext';
import { Header } from './components/Header';
import { WaiterApp } from './waiter_mobile/WaiterApp';
import { ServerLaptopApp } from './server_laptop/ServerLaptopApp';

const AppContent = () => {
  const { deviceMode } = usePos();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header />

      <main style={{
        flex: 1,
        maxWidth: '1280px',
        width: '100%',
        margin: '0 auto',
        padding: '24px 16px 40px'
      }}>
        {deviceMode === 'waiter_mobile' && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <WaiterApp />
          </div>
        )}

        {deviceMode === 'laptop_server' && (
          <ServerLaptopApp />
        )}

        {deviceMode === 'dual_demo' && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(320px, 420px) 1fr',
            gap: '24px',
            alignItems: 'start'
          }}>
            <div>
              <div style={{
                textAlign: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: 'var(--status-amber-text)',
                textTransform: 'uppercase',
                letterSpacing: '1.2px',
                marginBottom: '10px',
                fontWeight: 700
              }}>
                📱 Waiter Mobile Handset (Folder: waiter_mobile)
              </div>
              <WaiterApp />
            </div>

            <div>
              <div style={{
                textAlign: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: 'var(--status-amber-text)',
                textTransform: 'uppercase',
                letterSpacing: '1.2px',
                marginBottom: '10px',
                fontWeight: 700
              }}>
                💻 Laptop / Reception & KDS System (Folder: server_laptop)
              </div>
              <ServerLaptopApp />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default function App() {
  return (
    <PosProvider>
      <AppContent />
    </PosProvider>
  );
}
