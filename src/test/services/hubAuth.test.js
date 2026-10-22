import { describe, expect, it } from 'vitest';

import { enrollWithCode, getToken, clearToken } from '@/services/hubAuth';
import { fakeHub } from '../helpers/fakeHub';

// How a device asks the hub for its token. The one rule that matters here is that a device asks for a
// narrower authority only when it says so: a waiter's phone sends nothing extra and gets what it always did.

const TOKEN = 'a'.repeat(64);
const reply = { 'POST /auth/device': { body: { success: true, device_token: TOKEN } } };

describe('enrolling a device', () => {
  it('a handset asks for nothing special -- no scope is sent, so it is enrolled as a handset', async () => {
    clearToken();
    const hub = fakeHub(reply);
    const result = await enrollWithCode('http://hub.local:4000', 'ABC123', 'Waiter handset');

    expect(result).toMatchObject({ ok: true, token: TOKEN });
    expect(hub.calls('POST /auth/device')[0].body).toEqual({ enrollment_code: 'ABC123', device_label: 'Waiter handset' });
    expect(getToken()).toBe(TOKEN);
  });

  it('a screen at the pass says so, and the hub is told it is a kitchen screen', async () => {
    clearToken();
    const hub = fakeHub(reply);
    await enrollWithCode('http://hub.local:4000', 'ABC123', 'Bar screen', { scope: 'kitchen' });

    expect(hub.calls('POST /auth/device')[0].body).toEqual({ enrollment_code: 'ABC123', device_label: 'Bar screen', scope: 'kitchen' });
  });

  it('a refusal keeps no token, and passes the hub\'s own words on', async () => {
    clearToken();
    fakeHub({ 'POST /auth/device': { status: 401, body: { error: 'Invalid enrollment code.' } } });
    const result = await enrollWithCode('http://hub.local:4000', 'WRONG', 'Bar screen', { scope: 'kitchen' });

    expect(result).toEqual({ ok: false, error: 'Invalid enrollment code.' });
    expect(getToken()).toBeNull();
  });

  it('re-enrolling replaces the old token, so a tablet moved from the pass to the floor becomes a handset', async () => {
    clearToken();
    fakeHub({ 'POST /auth/device': { body: { success: true, device_token: 'k'.repeat(64) } } });
    await enrollWithCode('http://hub.local:4000', 'ABC123', 'Bar screen', { scope: 'kitchen' });
    expect(getToken()).toBe('k'.repeat(64));

    fakeHub({ 'POST /auth/device': { body: { success: true, device_token: 'h'.repeat(64) } } });
    await enrollWithCode('http://hub.local:4000', 'ABC123', 'Waiter handset');
    expect(getToken()).toBe('h'.repeat(64));
  });
});
