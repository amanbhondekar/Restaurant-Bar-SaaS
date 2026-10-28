import React from 'react';
import ReactDOM from 'react-dom/client';
import { installCrashReporter } from './services/crashReporter';
import { StationScreen } from './station/StationScreen';
import { stationFromPath } from './station/lib/board';
import './index.css';

installCrashReporter({ source: 'station' });

// The address says which station this is: /station/bar. Anything else is a mistyped link, and saying so
// is better than quietly showing the wrong station's tickets.
const station = stationFromPath(window.location.pathname);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {station ? (
      <StationScreen station={station} />
    ) : (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-2 px-6">
        <h1 className="typography-display-sm">Which station is this?</h1>
        <p className="text-muted-foreground">
          Open <strong>/station/hot</strong>, <strong>/station/cold</strong> or <strong>/station/bar</strong>, or scan the code for a station from the Kitchen tab on the reception laptop.
        </p>
      </main>
    )}
  </React.StrictMode>
);
