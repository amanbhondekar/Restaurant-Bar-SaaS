import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AdminApp } from '../src/AdminApp.jsx';
import { READY, apiError, authError, fakeApi, fakeAuth, fleetPayload } from './helpers.jsx';

// The console as a founder meets it: sign in with an email and password, set up (or answer) a second factor, be checked against the allowlist, have
// the sign-in recorded once, and only then see anything. At no point is a password, a code or a token written anywhere the page can be read back from.

const NOTE = { signedOut: /your session ended/i };

const setup = (auth, api = fakeApi(), props = {}) => {
  const user = userEvent.setup();
  render(<AdminApp auth={auth} api={api} pollMs={60000} tickMs={60000} timeZone="UTC" {...props} />);
  return { user, auth, api };
};
const typeInto = async (user, label, text) => { await user.clear(screen.getByLabelText(label)); await user.type(screen.getByLabelText(label), text); };

afterEach(() => { vi.useRealTimers(); });

describe('starting up', () => {
  it('says it is checking the session, then shows the sign-in form to someone who has none', async () => {
    let resolve;
    const auth = fakeAuth({ status: 'signed_out' }, { state: vi.fn(() => new Promise(r => { resolve = r; })) });
    setup(auth);
    expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
    resolve({ status: 'signed_out' });
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
    expect(screen.queryByText(/checking your session/i)).toBeNull();
  });

  it('shows nothing of the console until the person is ready, whatever state they arrive in', async () => {
    for (const start of [{ status: 'signed_out' }, { status: 'needs_enrolment', email: 'a@b.test' }, { status: 'needs_challenge', email: 'a@b.test', factorId: 'f' }]) {
      const api = fakeApi();
      const { unmount } = render(<AdminApp auth={fakeAuth(start)} api={api} pollMs={60000} tickMs={60000} />);
      await screen.findByRole('heading', { level: 2 });
      expect(api.fleet).not.toHaveBeenCalled();
      expect(api.me).not.toHaveBeenCalled();
      expect(screen.queryByRole('navigation')).toBeNull();
      unmount();
    }
  });

  it('fails closed: if the session cannot be read, it is sign-in, not the console', async () => {
    const auth = fakeAuth({ status: 'signed_out' }, { state: vi.fn(async () => { throw new Error('storage unavailable'); }) });
    setup(auth);
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
  });
});

describe('signing in with a password', () => {
  it('sends the email and the password, and moves on to wherever that leaves them', async () => {
    const auth = fakeAuth();
    auth.signIn.mockResolvedValue({ status: 'needs_enrolment', email: 'aman@example.test' });
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /sign in/i });
    await typeInto(user, /email/i, 'aman@example.test');
    await typeInto(user, /password/i, 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(auth.signIn).toHaveBeenCalledWith('aman@example.test', 'correct horse battery');
    expect(await screen.findByRole('heading', { name: /set up your second factor/i })).toBeInTheDocument();
  });

  it('asks for the right kinds of input: an email, a password hidden from view, and nothing for the browser to guess', async () => {
    setup(fakeAuth());
    await screen.findByRole('heading', { name: /sign in/i });
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText(/password/i)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/password/i)).toHaveAttribute('autocomplete', 'current-password');
  });

  it('does not try with an empty form', async () => {
    const { user, auth } = setup(fakeAuth());
    await screen.findByRole('heading', { name: /sign in/i });
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDisabled();
    await typeInto(user, /email/i, 'a@b.test');
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDisabled();
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('says it is working, and a double click sends one request', async () => {
    let finish;
    const auth = fakeAuth();
    auth.signIn.mockImplementation(() => new Promise(r => { finish = r; }));
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /sign in/i });
    await typeInto(user, /email/i, 'a@b.test');
    await typeInto(user, /password/i, 'pw');
    const button = screen.getByRole('button', { name: /^sign in$/i });
    await user.dblClick(button);
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
    finish({ status: 'needs_enrolment', email: 'a@b.test' });
    await screen.findByRole('heading', { name: /set up your second factor/i });
  });

  it('tells a wrong password in words that do not say which part was wrong, and clears the password', async () => {
    const auth = fakeAuth();
    auth.signIn.mockRejectedValue(authError('credentials', 'That email and password were not accepted.'));
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /sign in/i });
    await typeInto(user, /email/i, 'a@b.test');
    await typeInto(user, /password/i, 'wrong');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password were not accepted.');
    expect(screen.getByLabelText(/password/i)).toHaveValue('');
    expect(screen.getByLabelText(/email/i)).toHaveValue('a@b.test');
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeDisabled();
  });

  it('says a rate limit and a lost connection in their own words', async () => {
    for (const [kind, text] of [['locked', 'Too many tries. Wait a few minutes.'], ['offline', 'Could not reach the sign-in service.']]) {
      const auth = fakeAuth();
      auth.signIn.mockRejectedValue(authError(kind, text));
      const { unmount } = render(<AdminApp auth={auth} api={fakeApi()} pollMs={60000} tickMs={60000} />);
      const user = userEvent.setup();
      await screen.findByRole('heading', { name: /sign in/i });
      await user.type(screen.getByLabelText(/email/i), 'a@b.test');
      await user.type(screen.getByLabelText(/password/i), 'pw');
      await user.click(screen.getByRole('button', { name: /^sign in$/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      unmount();
    }
  });

  it('never shows an error it was not meant to say: an unexpected failure is a plain sentence, not its text', async () => {
    const auth = fakeAuth();
    auth.signIn.mockRejectedValue(new Error('TypeError: cannot read properties of undefined (reading "session") at x.js:12'));
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /sign in/i });
    await typeInto(user, /email/i, 'a@b.test');
    await typeInto(user, /password/i, 'pw');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/TypeError|undefined|x\.js/);
    expect(alert.textContent.length).toBeGreaterThan(10);
  });
});

describe('setting up a second factor', () => {
  const enrol = () => fakeAuth({ status: 'needs_enrolment', email: 'aman@example.test' });

  it('asks Supabase for a factor once, and shows the code to scan and the key to type if scanning is not possible', async () => {
    const { auth } = setup(enrol());
    expect(await screen.findByRole('heading', { name: /set up your second factor/i })).toBeInTheDocument();
    await waitFor(() => expect(auth.startEnrolment).toHaveBeenCalledTimes(1));
    const qr = await screen.findByRole('img', { name: /qr code/i });
    expect(qr).toHaveAttribute('src', expect.stringMatching(/^data:image\/svg\+xml/));
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByText(/aman@example\.test/)).toBeInTheDocument();
  });

  it('shows only a data: image, never an address someone else supplied', async () => {
    const auth = enrol();
    auth.startEnrolment.mockResolvedValue({ factorId: 'f', qr: 'https://evil.example/qr.svg', secret: 'ABC' });
    setup(auth);
    await screen.findByRole('heading', { name: /set up your second factor/i });
    await waitFor(() => expect(auth.startEnrolment).toHaveBeenCalled());
    expect(screen.queryByRole('img', { name: /qr code/i })).toBeNull();
    expect(screen.getByText('ABC')).toBeInTheDocument();
  });

  it('confirms the first code and goes on to be checked', async () => {
    const auth = enrol();
    auth.verifyEnrolment.mockResolvedValue(READY);
    const { user, api } = setup(auth);
    await screen.findByRole('img', { name: /qr code/i });
    await typeInto(user, /6-digit code/i, '123456');
    await user.click(screen.getByRole('button', { name: /confirm and continue/i }));
    expect(auth.verifyEnrolment).toHaveBeenCalledWith('factor-new', '123456');
    await waitFor(() => expect(api.me).toHaveBeenCalled());
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
  });

  it('does not send a code that cannot be one, and says what a code is', async () => {
    const { user, auth } = setup(enrol());
    await screen.findByRole('img', { name: /qr code/i });
    await typeInto(user, /6-digit code/i, '12ab');
    await user.click(screen.getByRole('button', { name: /confirm and continue/i }));
    expect(auth.verifyEnrolment).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/6 digits/i);
  });

  it('asks for a one-time code in a field a phone will offer it for', async () => {
    setup(enrol());
    await screen.findByRole('img', { name: /qr code/i });
    const field = screen.getByLabelText(/6-digit code/i);
    expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    expect(field).toHaveAttribute('inputmode', 'numeric');
  });

  it('keeps them on the screen with the same code to scan when the first code is wrong', async () => {
    const auth = enrol();
    auth.verifyEnrolment.mockRejectedValue(authError('code', 'That code was not accepted. Check your authenticator app and try again.'));
    const { user } = setup(auth);
    await screen.findByRole('img', { name: /qr code/i });
    await typeInto(user, /6-digit code/i, '000000');
    await user.click(screen.getByRole('button', { name: /confirm and continue/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not accepted/i);
    expect(screen.getByRole('img', { name: /qr code/i })).toBeInTheDocument();
    expect(auth.startEnrolment).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/6-digit code/i)).toHaveValue('');
  });

  it('can be started again, which makes a new code', async () => {
    const { user, auth } = setup(enrol());
    await screen.findByRole('img', { name: /qr code/i });
    await user.click(screen.getByRole('button', { name: /start again/i }));
    await waitFor(() => expect(auth.startEnrolment).toHaveBeenCalledTimes(2));
  });

  it('says so when a factor cannot be made, and offers to try again', async () => {
    const auth = enrol();
    auth.startEnrolment.mockRejectedValueOnce(authError('other', 'Could not set up a second factor. Try again in a moment.'));
    const { user } = setup(auth);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not set up/i);
    expect(screen.queryByRole('img', { name: /qr code/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /try again|start again/i }));
    expect(await screen.findByRole('img', { name: /qr code/i })).toBeInTheDocument();
  });

  it('leaves no code or key behind once they are signed out', async () => {
    const { user } = setup(enrol());
    await screen.findByRole('img', { name: /qr code/i });
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await screen.findByRole('heading', { name: /sign in to the admin console/i });
    expect(screen.queryByText('JBSWY3DPEHPK3PXP')).toBeNull();
    expect(document.body.innerHTML).not.toContain('JBSWY3DPEHPK3PXP');
  });
});

describe('answering the second factor', () => {
  const challenge = () => fakeAuth({ status: 'needs_challenge', email: 'aman@example.test', factorId: 'factor-1' });

  it('asks for a code and checks it against the factor they already have', async () => {
    const auth = challenge();
    auth.challenge.mockResolvedValue(READY);
    const { user, api } = setup(auth);
    expect(await screen.findByRole('heading', { name: /enter your code/i })).toBeInTheDocument();
    expect(auth.startEnrolment).not.toHaveBeenCalled();
    await typeInto(user, /6-digit code/i, '654 321');
    await user.click(screen.getByRole('button', { name: /^verify$/i }));
    expect(auth.challenge).toHaveBeenCalledWith('factor-1', '654321');
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(api.me).toHaveBeenCalled();
  });

  it('says a wrong code is a wrong code and lets them try again', async () => {
    const auth = challenge();
    auth.challenge.mockRejectedValueOnce(authError('code', 'That code was not accepted. Check your authenticator app and try again.'));
    auth.challenge.mockResolvedValueOnce(READY);
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /enter your code/i });
    await typeInto(user, /6-digit code/i, '000000');
    await user.click(screen.getByRole('button', { name: /^verify$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not accepted/i);
    await typeInto(user, /6-digit code/i, '111111');
    await user.click(screen.getByRole('button', { name: /^verify$/i }));
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
  });

  it('names the account that is signing in, so the wrong one is noticed', async () => {
    setup(challenge());
    await screen.findByRole('heading', { name: /enter your code/i });
    expect(screen.getByText(/aman@example\.test/)).toBeInTheDocument();
  });

  it('lets them sign out instead', async () => {
    const { user, auth } = setup(challenge());
    await screen.findByRole('heading', { name: /enter your code/i });
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(auth.signOut).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
  });
});

describe('being let in', () => {
  it('asks who they are, records the sign-in once, and only then shows the console', async () => {
    const order = [];
    const api = fakeApi({
      me: vi.fn(async () => { order.push('me'); return { success: true, user: { id: 'f1', email: 'aman@example.test', display_name: 'Aman', role: 'founder' } }; }),
      recordSession: vi.fn(async () => { order.push('record'); return { success: true, event_id: 9 }; }),
      fleet: vi.fn(async () => { order.push('fleet'); return fleetPayload(); })
    });
    setup(fakeAuth(READY), api);
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(order.slice(0, 2)).toEqual(['me', 'record']);
    expect(api.recordSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText('aman@example.test')).toBeInTheDocument();
  });

  it('records the sign-in once however many times the state is announced', async () => {
    const auth = fakeAuth(READY);
    const { api } = setup(auth);
    await screen.findByRole('navigation');
    auth.emit(READY);
    auth.emit(READY);
    await new Promise(r => setTimeout(r, 20));
    expect(api.recordSession).toHaveBeenCalledTimes(1);
  });

  it('shows a clear screen to someone who is signed in but is not an administrator, and records nothing', async () => {
    const api = fakeApi({ me: vi.fn(async () => { throw apiError('not_admin', 'This is for the administrators.'); }) });
    const { user, auth } = setup(fakeAuth(READY), api);
    expect(await screen.findByRole('heading', { name: /this account is not an administrator/i })).toBeInTheDocument();
    expect(screen.getByText(/aman@example\.test/)).toBeInTheDocument();
    expect(api.recordSession).not.toHaveBeenCalled();
    expect(api.fleet).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation')).toBeNull();
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(auth.signOut).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
  });

  it('sends them back to answer the second factor if the API says it was not used', async () => {
    const auth = fakeAuth(READY);
    const api = fakeApi({ me: vi.fn(async () => { throw apiError('mfa', 'Sign in with your second factor.'); }) });
    auth.state.mockResolvedValueOnce(READY).mockResolvedValue({ status: 'needs_challenge', email: 'aman@example.test', factorId: 'f1' });
    setup(auth, api);
    expect(await screen.findByRole('heading', { name: /enter your code/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('ends the session if the API does not accept the token any more, and says so', async () => {
    const auth = fakeAuth(READY);
    const api = fakeApi({ me: vi.fn(async () => { throw apiError('denied', 'Sign in again.'); }) });
    setup(auth, api);
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(NOTE.signedOut);
  });

  it('does not show the console if the API cannot be reached, and offers to try again', async () => {
    const api = fakeApi();
    api.me.mockRejectedValueOnce(apiError('offline', 'Could not reach the admin service.'));
    const { user } = setup(fakeAuth(READY), api);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach/i);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(api.recordSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    expect(api.recordSession).toHaveBeenCalledTimes(1);
  });

  it('does not let them in if recording the sign-in fails: an unrecorded sign-in is not a sign-in', async () => {
    const api = fakeApi({ recordSession: vi.fn(async () => { throw apiError('down', 'The database did not answer.'); }) });
    setup(fakeAuth(READY), api);
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not answer/i);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('leaving', () => {
  it('signs out from the console and shows the sign-in form with nothing of the console left', async () => {
    const { user, auth } = setup(fakeAuth(READY));
    await screen.findByRole('navigation');
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(auth.signOut).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
    expect(screen.queryByText('Spice Route')).toBeNull();
    expect(screen.getByLabelText(/password/i)).toHaveValue('');
  });

  it('goes to sign-in at once if the session ends somewhere else, and says so', async () => {
    const auth = fakeAuth(READY);
    setup(auth);
    await screen.findByRole('navigation');
    auth.emit({ status: 'signed_out' });
    expect(await screen.findByRole('heading', { name: /sign in to the admin console/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(NOTE.signedOut);
    expect(screen.queryByText('Spice Route')).toBeNull();
  });

  it('stops listening for changes when the page is closed', async () => {
    const auth = fakeAuth();
    const stop = vi.fn();
    auth.onChange.mockReturnValue(stop);
    const { unmount } = render(<AdminApp auth={auth} api={fakeApi()} pollMs={60000} tickMs={60000} />);
    await screen.findByRole('heading', { name: /sign in/i });
    unmount();
    expect(stop).toHaveBeenCalled();
  });
});

describe('a notice belongs to the sign-in it was for', () => {
  it('does not follow someone through a later sign-out', async () => {
    const auth = fakeAuth(READY);
    const { user } = setup(auth);
    await screen.findByRole('navigation');
    auth.emit({ status: 'signed_out' });
    expect(await screen.findByRole('status')).toHaveTextContent(NOTE.signedOut);
    auth.signIn.mockResolvedValue(READY);
    await typeInto(user, /email/i, 'aman@example.test');
    await typeInto(user, /password/i, 'pw');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await screen.findByRole('navigation');
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await screen.findByRole('heading', { name: /sign in to the admin console/i });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the page starts things once even when React runs its effects twice', () => {
  it('records the sign-in once', async () => {
    const api = fakeApi();
    render(<React.StrictMode><AdminApp auth={fakeAuth(READY)} api={api} pollMs={60000} tickMs={60000} /></React.StrictMode>);
    await screen.findByRole('navigation');
    expect(api.recordSession).toHaveBeenCalledTimes(1);
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it('makes one second factor, not two', async () => {
    const auth = fakeAuth({ status: 'needs_enrolment', email: 'aman@example.test' });
    render(<React.StrictMode><AdminApp auth={auth} api={fakeApi()} pollMs={60000} tickMs={60000} /></React.StrictMode>);
    await screen.findByRole('img', { name: /qr code/i });
    expect(auth.startEnrolment).toHaveBeenCalledTimes(1);
  });
});

describe('a form is sent once', () => {
  it('sends the sign-in once even if it is submitted twice before the page has caught up', async () => {
    let finish;
    const auth = fakeAuth();
    auth.signIn.mockImplementation(() => new Promise(r => { finish = r; }));
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /sign in/i });
    await typeInto(user, /email/i, 'a@b.test');
    await typeInto(user, /password/i, 'pw');
    const form = screen.getByRole('button', { name: /^sign in$/i }).closest('form');
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ status: 'needs_enrolment', email: 'a@b.test' }); });
  });

  it('sends the code once even if it is submitted twice before the page has caught up', async () => {
    let finish;
    const auth = fakeAuth({ status: 'needs_challenge', email: 'aman@example.test', factorId: 'f1' });
    auth.challenge.mockImplementation(() => new Promise(r => { finish = r; }));
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /enter your code/i });
    await typeInto(user, /6-digit code/i, '123456');
    const form = screen.getByRole('button', { name: /^verify$/i }).closest('form');
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(auth.challenge).toHaveBeenCalledTimes(1);
    await act(async () => { finish(READY); });
  });
});

describe('a code is sent as six digits and only as six digits', () => {
  it('drops the space an authenticator app shows, when setting up', async () => {
    const auth = fakeAuth({ status: 'needs_enrolment', email: 'aman@example.test' });
    auth.verifyEnrolment.mockResolvedValue(READY);
    const { user } = setup(auth);
    await screen.findByRole('img', { name: /qr code/i });
    await typeInto(user, /6-digit code/i, '123 456');
    await user.click(screen.getByRole('button', { name: /confirm and continue/i }));
    expect(auth.verifyEnrolment).toHaveBeenCalledWith('factor-new', '123456');
  });

  it('does not send a code that cannot be one, when answering', async () => {
    const auth = fakeAuth({ status: 'needs_challenge', email: 'aman@example.test', factorId: 'f1' });
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /enter your code/i });
    await typeInto(user, /6-digit code/i, '12ab');
    await user.click(screen.getByRole('button', { name: /^verify$/i }));
    expect(auth.challenge).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/6 digits/i);
  });
});

describe('nothing sensitive is kept', () => {
  it('leaves the browser\'s storage and cookies empty through a whole sign-in', async () => {
    const auth = fakeAuth();
    auth.signIn.mockResolvedValue({ status: 'needs_challenge', email: 'aman@example.test', factorId: 'f1' });
    auth.challenge.mockResolvedValue(READY);
    const { user } = setup(auth);
    await screen.findByRole('heading', { name: /sign in/i });
    await typeInto(user, /email/i, 'aman@example.test');
    await typeInto(user, /password/i, 'a very secret password');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await typeInto(user, /6-digit code/i, '123456');
    await user.click(screen.getByRole('button', { name: /^verify$/i }));
    await screen.findByRole('navigation');
    expect([localStorage.length, sessionStorage.length, document.cookie]).toEqual([0, 0, '']);
    expect(window.location.href).not.toMatch(/token|password|code/i);
    expect(document.body.innerHTML).not.toContain('a very secret password');
  });
});
