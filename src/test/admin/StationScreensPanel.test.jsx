import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StationScreensPanel } from '@/admin/StationScreensPanel';
import { KitchenTab } from '@/admin/KitchenTab';
import { STATION_ORDER, anyScreensUp, stationStatus, unwatchedLine, waitingText } from '@/admin/lib/stations';
import { fakeHub } from '../helpers/fakeHub';

const st = (label, online, tickets = 0, items = 0) => ({ label, online, waiting_tickets: tickets, waiting_items: items });
const snap = (hot, cold, bar) => ({ hot, cold, bar });
const answer = stations => ({ body: { success: true, stations, screens: [] } });

describe('station status wording', () => {
  it('counts tickets and items, singular and plural', () => {
    expect(waitingText(1, 1)).toBe('1 ticket (1 item)');
    expect(waitingText(3, 5)).toBe('3 tickets (5 items)');
  });

  it('a station with a screen is fine, whether or not anything is waiting', () => {
    expect(stationStatus(st('Bar', 1), true)).toMatchObject({ tone: 'green', unwatched: false, headline: '1 screen up', detail: 'Nothing waiting' });
    expect(stationStatus(st('Bar', 2, 3, 5), true)).toMatchObject({ tone: 'green', headline: '2 screens up', detail: '3 tickets (5 items) waiting' });
  });

  it('a station with work waiting and no screen is flagged -- once the restaurant is using station screens', () => {
    const s = stationStatus(st('Bar', 0, 2, 4), true);
    expect(s).toMatchObject({ tone: 'rust', unwatched: true, headline: 'No screen' });
    expect(s.detail).toBe('2 tickets (4 items) waiting and nobody is looking at them');
  });

  it('but a restaurant that uses no station screens is not told every station is unwatched', () => {
    const s = stationStatus(st('Bar', 0, 2, 4), false);
    expect(s).toMatchObject({ tone: 'muted', unwatched: false });
    expect(s.detail).toBe('2 tickets (4 items) waiting, shown on the Kitchen Display');
  });

  it('a station with no screen and nothing waiting is simply quiet', () => {
    expect(stationStatus(st('Bar', 0), true)).toMatchObject({ tone: 'muted', unwatched: false, detail: 'Nothing waiting' });
    expect(stationStatus(undefined, true)).toMatchObject({ tone: 'muted', headline: 'No screen' });
  });

  it('knows whether any station screen is connected', () => {
    expect(anyScreensUp(snap(st('H', 0), st('C', 0), st('B', 0)))).toBe(false);
    expect(anyScreensUp(snap(st('H', 0), st('C', 0), st('B', 1)))).toBe(true);
    expect(anyScreensUp(undefined)).toBe(false);
  });

  it('the warning line names the unwatched stations, and only when one screen is up somewhere', () => {
    expect(unwatchedLine(snap(st('Hot line', 1, 1, 1), st('Cold line', 0), st('Bar', 0, 2, 3)))).toBe('Bar has work waiting and no screen connected.');
    expect(unwatchedLine(snap(st('Hot line', 1), st('Cold line', 0, 1, 1), st('Bar', 0, 2, 3)))).toBe('Cold line and Bar have work waiting and no screen connected.');
    expect(unwatchedLine(snap(st('Hot line', 0, 4, 9), st('Cold line', 0), st('Bar', 0, 2, 3)))).toBe('');
    expect(unwatchedLine(snap(st('Hot line', 1, 1, 1), st('Cold line', 1), st('Bar', 1)))).toBe('');
  });

  it('lists the stations in the order the kitchen is laid out', () => {
    expect(STATION_ORDER).toEqual(['hot', 'cold', 'bar']);
  });
});

describe('station screens panel', () => {
  it('shows each station with how many screens are up and what is waiting', async () => {
    fakeHub({ 'GET /kds/screens': answer(snap(st('Hot line', 1, 2, 3), st('Cold line', 0), st('Bar', 1))) });
    render(<StationScreensPanel />);

    const hot = await screen.findByRole('listitem', { name: 'Hot line' });
    expect(within(hot).getByText('1 screen up')).toBeInTheDocument();
    expect(within(hot).getByText('2 tickets (3 items) waiting')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Cold line' })).getByText('No screen')).toBeInTheDocument();
    expect(screen.queryByText('A station is unwatched')).not.toBeInTheDocument();
  });

  it('warns at the top when a station has work and nobody watching it', async () => {
    fakeHub({ 'GET /kds/screens': answer(snap(st('Hot line', 1), st('Cold line', 0), st('Bar', 0, 3, 4))) });
    render(<StationScreensPanel />);
    expect(await screen.findByText('A station is unwatched')).toBeInTheDocument();
    expect(screen.getByText('Bar has work waiting and no screen connected.')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'Bar' })).getByText(/3 tickets \(4 items\) waiting and nobody/)).toBeInTheDocument();
  });

  it('with no station screen anywhere, says tickets show on the Kitchen Display and raises no alarm', async () => {
    fakeHub({ 'GET /kds/screens': answer(snap(st('Hot line', 0, 5, 9), st('Cold line', 0), st('Bar', 0, 1, 1))) });
    render(<StationScreensPanel />);
    expect(await screen.findByText(/Until one is connected, every ticket shows on the Kitchen Display/)).toBeInTheDocument();
    expect(screen.queryByText('A station is unwatched')).not.toBeInTheDocument();
  });

  it('opening a station\'s page offers a link that goes to that station', async () => {
    fakeHub({ 'GET /kds/screens': answer(snap(st('Hot line', 0), st('Cold line', 0), st('Bar', 0))) });
    render(<StationScreensPanel />);
    const bar = await screen.findByRole('listitem', { name: 'Bar' });
    const link = within(bar).getByRole('link', { name: /Open here/ });
    expect(link.getAttribute('href')).toMatch(/\/station\/bar$/);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('adding a tablet shows the code for that station, with a way in if the camera does not work', async () => {
    const hub = fakeHub({
      'GET /kds/screens': answer(snap(st('Hot line', 0), st('Cold line', 0), st('Bar', 0))),
      'GET /qr/station/bar': { body: { success: true, station: 'bar', label: 'Bar', station_url: 'http://192.168.1.20:4000/station/bar', enrollment_code: 'KIT7492', qr_code: 'data:image/png;base64,AAAA' } }
    });
    render(<StationScreensPanel />);
    await userEvent.click(within(await screen.findByRole('listitem', { name: 'Bar' })).getByRole('button', { name: /Add a tablet/ }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('img', { name: /turns a tablet into the bar screen/i })).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(within(dialog).getByText('http://192.168.1.20:4000/station/bar')).toBeInTheDocument();
    expect(within(dialog).getByText('KIT7492')).toBeInTheDocument();
    expect(hub.calls('GET /qr/station/bar')).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('if the code cannot be fetched, the dialog says so instead of showing a blank', async () => {
    fakeHub({
      'GET /kds/screens': answer(snap(st('Hot line', 0), st('Cold line', 0), st('Bar', 0))),
      'GET /qr/station/hot': { status: 403, body: { code: 'RECEPTION_ONLY', error: 'Reception only' } }
    });
    render(<StationScreensPanel />);
    await userEvent.click(within(await screen.findByRole('listitem', { name: 'Hot line' })).getByRole('button', { name: /Add a tablet/ }));
    expect(await within(await screen.findByRole('dialog')).findByText(/only works on the reception laptop/)).toBeInTheDocument();
  });

  it('when the hub cannot be asked, says so rather than showing three stations that look fine', async () => {
    fakeHub({ 'GET /kds/screens': new TypeError('Failed to fetch') });
    render(<StationScreensPanel />);
    expect(await screen.findByText('Could not check the station screens')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('sits at the top of the Kitchen tab, and shows even while the performance report is still loading', async () => {
    fakeHub({
      'GET /kds/screens': answer(snap(st('Hot line', 1), st('Cold line', 0), st('Bar', 0))),
      'GET /telemetry/prep': new TypeError('Failed to fetch')
    });
    render(<KitchenTab />);
    expect(await screen.findByRole('heading', { name: 'Station screens' })).toBeInTheDocument();
    expect(await screen.findByText('Could not load kitchen performance')).toBeInTheDocument();
  });
});
