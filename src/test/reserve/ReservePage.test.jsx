import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReservePage } from '@/reserve/ReservePage';
import { checkRequest, inputValue, requestBody, codeFromPath } from '@/reserve/lib/form';
import { fakeHub, deferred } from '../helpers/fakeHub';

// The page where a guest asks a restaurant for a table (§4.6). It is opened from an address on a card or a screen, on the guest's own phone,
// by someone who has never seen it before. What matters: it says plainly that this is a request and not a booking, it tells the guest what is
// wrong with the form in words, it does not lose what they typed when something fails, and it can only be sent once.

const NOW = new Date(2026, 9, 23, 12, 0, 0);
const LIMITS = { max_party: 20, min_notice_mins: 30, max_ahead_days: 60 };
const PAGE = { body: { success: true, restaurant: { name: 'Mejwani', city: 'Nagpur' }, limits: LIMITS } };
const CODE = 'pagecode12';
const INFO = `GET /public/booking/${CODE}`;
const SEND = `POST /public/booking/${CODE}/requests`;
const SENT = { status: 201, body: { success: true } };

const at = (day, time) => `2026-10-${day}T${time}`;
const open = (path = `/book/${CODE}`) => window.history.pushState({}, '', path);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  open();
});
afterEach(() => { vi.useRealTimers(); window.history.pushState({}, '', '/'); });

async function fill({ name = 'Asha Rao', phone = '98765 43210', people, when = at(24, '19:30'), note } = {}) {
  await userEvent.type(screen.getByLabelText('Your name'), name);
  await userEvent.type(screen.getByLabelText('Phone number'), phone);
  if (people) await userEvent.selectOptions(screen.getByLabelText('How many people'), String(people));
  fireEvent.change(screen.getByLabelText('Day and time'), { target: { value: when } });
  if (note) await userEvent.type(screen.getByLabelText(/Anything we should know/), note);
}
const send = () => userEvent.click(screen.getByRole('button', { name: 'Send request' }));
const ready = async (routes = {}) => {
  const hub = fakeHub({ [INFO]: PAGE, ...routes });
  render(<ReservePage />);
  await screen.findByRole('heading', { level: 1 });
  return hub;
};

// --- the form's rules, without the page ---------------------------------------------------------------------------------

describe('what a guest has to fill in', () => {
  const good = { guest_name: 'Asha Rao', phone: '98765 43210', party_size: '4', at: at(24, '19:30'), note: '' };

  it('a good request is good', () => {
    expect(checkRequest(good, LIMITS, NOW)).toEqual({ ok: true, errors: {} });
  });

  it('says what is missing or wrong, field by field, in words for a guest', () => {
    const r = checkRequest({ guest_name: '  ', phone: '123', party_size: '0', at: '', note: 'x'.repeat(201) }, LIMITS, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.guest_name).toMatch(/your name/i);
    expect(r.errors.phone).toMatch(/phone number/i);
    expect(r.errors.party_size).toMatch(/between 1 and 20/);
    expect(r.errors.at).toMatch(/day and time/i);
    expect(r.errors.note).toMatch(/200/);
  });

  it('a name can be as long as the restaurant will take, and no longer', () => {
    expect(checkRequest({ ...good, guest_name: 'x'.repeat(80) }, LIMITS, NOW).ok).toBe(true);
    expect(checkRequest({ ...good, guest_name: 'x'.repeat(81) }, LIMITS, NOW).errors.guest_name).toMatch(/80/);
  });

  it('a number is ten digits or more however it is written, and anything with letters in it is not a number', () => {
    for (const phone of ['98765 43210', '+91 98765-43210', '098765 43210', '9876543210']) expect(checkRequest({ ...good, phone }, LIMITS, NOW).errors.phone, phone).toBeUndefined();
    for (const phone of ['', '12345', '98765 4321', 'call me', '98765 4321a0']) expect(checkRequest({ ...good, phone }, LIMITS, NOW).errors.phone, phone).toBeDefined();
  });

  it('a party is a whole number from 1 to the most the restaurant allows', () => {
    for (const n of ['1', '20']) expect(checkRequest({ ...good, party_size: n }, LIMITS, NOW).errors.party_size, n).toBeUndefined();
    for (const n of ['0', '21', '2.5', '', 'two']) expect(checkRequest({ ...good, party_size: n }, LIMITS, NOW).errors.party_size, n).toMatch(/between 1 and 20/);
    expect(checkRequest({ ...good, party_size: '8' }, { ...LIMITS, max_party: 8 }, NOW).errors.party_size).toBeUndefined();
    expect(checkRequest({ ...good, party_size: '9' }, { ...LIMITS, max_party: 8 }, NOW).errors.party_size).toMatch(/between 1 and 8/);
  });

  it('a time must give the restaurant its notice, and be no further ahead than they take requests', () => {
    expect(checkRequest({ ...good, at: at(23, '12:29') }, LIMITS, NOW).errors.at).toMatch(/30 minutes/);
    expect(checkRequest({ ...good, at: at(23, '12:30') }, LIMITS, NOW).errors.at).toBeUndefined();
    expect(checkRequest({ ...good, at: at(23, '11:00') }, LIMITS, NOW).errors.at).toMatch(/30 minutes/);
    expect(checkRequest({ ...good, at: '2026-12-22T12:00' }, LIMITS, NOW).errors.at).toBeUndefined();
    expect(checkRequest({ ...good, at: '2026-12-22T12:01' }, LIMITS, NOW).errors.at).toMatch(/60 days/);
    expect(checkRequest({ ...good, at: 'not a time' }, LIMITS, NOW).errors.at).toMatch(/day and time/i);
    expect(checkRequest({ ...good, at: at(24, '19:30') }, { ...LIMITS, min_notice_mins: 120 }, NOW).errors.at).toBeUndefined();
    expect(checkRequest({ ...good, at: at(23, '13:59') }, { ...LIMITS, min_notice_mins: 120 }, NOW).errors.at).toMatch(/2 hours|120 minutes/);
  });

  it('is sent as the moment it names, with the words trimmed, and no note at all when there is none', () => {
    const body = requestBody({ ...good, guest_name: '  Asha Rao ', note: '   ' }, 'x');
    expect(body).toEqual({ guest_name: 'Asha Rao', phone: '98765 43210', party_size: 4, at: new Date(2026, 9, 24, 19, 30).toISOString(), website: 'x' });
    expect(requestBody({ ...good, note: ' Window ' }).note).toBe('Window');
    expect(requestBody(good).website).toBe('');
  });

  it('a time input\'s own format is local, to the minute', () => {
    expect(inputValue(new Date(2026, 9, 23, 9, 5))).toBe('2026-10-23T09:05');
    expect(inputValue(new Date(2026, 11, 1, 23, 59))).toBe('2026-12-01T23:59');
  });

  it('the page\'s code is the last part of the address, and only a code will do', () => {
    expect(codeFromPath('/book/pagecode12')).toBe('pagecode12');
    expect(codeFromPath('/book/pagecode12/')).toBe('pagecode12');
    for (const bad of ['/', '/book', '/book/', '/book/SHORT', '/book/has space', '/book/' + 'a'.repeat(33), '/other/pagecode12', '/book/pagecode12/more', '']) expect(codeFromPath(bad), bad).toBeNull();
  });
});

// --- the page --------------------------------------------------------------------------------------------------------------

describe('the booking page', () => {
  it('opened without a code asks nothing of anyone and says the page is not available', () => {
    open('/book');
    const hub = fakeHub({});
    render(<ReservePage />);
    expect(screen.getByRole('heading', { name: 'This booking page is not available' })).toBeInTheDocument();
    expect(hub.all()).toHaveLength(0);
  });

  it('names the restaurant and its city, says this is a request, and offers the form', async () => {
    await ready();
    expect(screen.getByRole('heading', { level: 1, name: 'Ask for a table at Mejwani' })).toBeInTheDocument();
    expect(screen.getByText('Nagpur')).toBeInTheDocument();
    expect(screen.getByText(/This is a request, not a booking/)).toBeInTheDocument();
    expect(screen.getByText(/Mejwani will reply on WhatsApp or by phone to confirm/)).toBeInTheDocument();
    expect(screen.getByText(/Your number is used only to answer this request/)).toBeInTheDocument();
    for (const label of ['Your name', 'Phone number', 'How many people', 'Day and time']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled();
  });

  it('offers a party of 1 up to what the restaurant takes, starting at 2, and the earliest and latest time it accepts', async () => {
    await ready();
    const options = within(screen.getByLabelText('How many people')).getAllByRole('option').map(o => o.value);
    expect(options).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    expect(screen.getByLabelText('How many people')).toHaveValue('2');
    const when = screen.getByLabelText('Day and time');
    expect(when).toHaveAttribute('min', '2026-10-23T12:30');
    expect(when).toHaveAttribute('max', '2026-12-22T12:00');
    expect(screen.getByLabelText(/Anything we should know/)).toHaveAttribute('maxlength', '200');
  });

  it('a page that is not there, switched off or unknown, says so and shows no form', async () => {
    fakeHub({ [INFO]: { status: 404, body: { success: false, code: 'NOT_FOUND', error: 'This booking page is not available.' } } });
    render(<ReservePage />);
    expect(await screen.findByRole('heading', { name: 'This booking page is not available' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
  });

  it('if the page cannot be loaded it says so and can try again', async () => {
    let up = false;
    fakeHub({ [INFO]: () => (up ? PAGE : new TypeError('fetch failed')) });
    render(<ReservePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this page/i);
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Mejwani/ })).toBeInTheDocument();
  });

  it('has a field only a robot fills in, which a person never sees, tabs to or hears', async () => {
    await ready();
    const trap = document.querySelector('input[name="website"]');
    expect(trap).not.toBeNull();
    expect(trap).toHaveValue('');
    expect(trap).toHaveAttribute('tabindex', '-1');
    expect(trap).toHaveAttribute('autocomplete', 'off');
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('a request that is not good is not sent, says what is wrong at each field, and is sent once it is fixed', async () => {
    const hub = await ready({ [SEND]: SENT });
    await send();
    expect(hub.calls(SEND)).toHaveLength(0);
    expect(screen.getByLabelText('Your name')).toHaveAccessibleDescription(/your name/i);
    expect(screen.getByLabelText('Phone number')).toHaveAccessibleDescription(/phone number/i);
    expect(screen.getByLabelText('Day and time')).toHaveAccessibleDescription(/day and time/i);
    expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-invalid', 'true');

    await fill();
    expect(screen.getByLabelText('Your name')).not.toHaveAttribute('aria-invalid', 'true');
    await send();
    await waitFor(() => expect(hub.calls(SEND)).toHaveLength(1));
  });

  it('sends exactly what was asked for, then says it is a request that the restaurant will answer, not a booking', async () => {
    const hub = await ready({ [SEND]: SENT });
    await fill({ people: 4, note: 'Window, if possible' });
    await send();
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(hub.calls(SEND)[0].body).toEqual({
      guest_name: 'Asha Rao', phone: '98765 43210', party_size: 4, at: new Date(2026, 9, 24, 19, 30).toISOString(), note: 'Window, if possible', website: ''
    });
    expect(screen.getByText(/Mejwani will message you to confirm/)).toBeInTheDocument();
    expect(screen.getByText(/not a confirmed booking yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
  });

  it('can be used again for another table, from a blank form', async () => {
    await ready({ [SEND]: SENT });
    await fill();
    await send();
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for another table' }));
    expect(screen.getByLabelText('Your name')).toHaveValue('');
    expect(screen.getByLabelText('Phone number')).toHaveValue('');
    expect(screen.getByLabelText('How many people')).toHaveValue('2');
  });

  it('cannot be sent twice by pressing twice: the button is off while the request is out', async () => {
    const slow = deferred();
    const hub = await ready({ [SEND]: () => slow.promise });
    await fill();
    await send();
    const button = screen.getByRole('button', { name: /Sending/ });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(hub.calls(SEND)).toHaveLength(1);
    slow.resolve(SENT);
    await screen.findByRole('heading', { name: 'Request sent' });
  });

  it('what the restaurant\'s service refuses is shown at the field it is about, and what was typed is kept', async () => {
    const hub = await ready({
      [SEND]: { status: 400, body: { success: false, code: 'INVALID_REQUEST', error: 'x', errors: [{ field: 'phone', message: 'Please give a phone number the restaurant can reach you on.' }, { field: 'at', message: 'Please choose a time at least 30 minutes from now. To book sooner, phone the restaurant.' }] } }
    });
    await fill({ note: 'Quiet corner' });
    await send();
    await waitFor(() => expect(screen.getByLabelText('Phone number')).toHaveAccessibleDescription(/can reach you on/));
    expect(screen.getByLabelText('Day and time')).toHaveAccessibleDescription(/phone the restaurant/);
    expect(screen.getByLabelText('Your name')).toHaveValue('Asha Rao');
    expect(screen.getByLabelText(/Anything we should know/)).toHaveValue('Quiet corner');
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled();
    expect(hub.calls(SEND)).toHaveLength(1);
  });

  it('too many requests, a restaurant that is not taking any, and a network that fails are each said in words, and nothing typed is lost', async () => {
    const answers = [
      { status: 429, body: { success: false, code: 'TOO_MANY', error: 'That is a lot of requests. Please wait a little, or phone the restaurant.' } },
      { status: 503, body: { success: false, code: 'NOT_TAKING_REQUESTS', error: 'This restaurant is not taking online requests right now. Please phone them.' } },
      new TypeError('fetch failed')
    ];
    let n = 0;
    await ready({ [SEND]: () => answers[n++] });
    await fill();
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent('That is a lot of requests');
    await send();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not taking online requests right now'));
    await send();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not send that/i));
    expect(screen.getByLabelText('Your name')).toHaveValue('Asha Rao');
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled();
  });

  it('a failure with no words of its own still says something, and a success clears an earlier failure', async () => {
    const answers = [{ status: 502, body: {} }, SENT];
    let n = 0;
    await ready({ [SEND]: () => answers[n++] });
    await fill();
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send that/i);
    await send();
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('if the page is switched off while it is open, sending says it is not available', async () => {
    await ready({ [SEND]: { status: 404, body: { success: false, code: 'NOT_FOUND', error: 'This booking page is not available.' } } });
    await fill();
    await send();
    expect(await screen.findByRole('heading', { name: 'This booking page is not available' })).toBeInTheDocument();
  });

  it('a note typed is sent, and one that is only spaces is not', async () => {
    const hub = await ready({ [SEND]: SENT });
    await fill({ note: '   ' });
    await send();
    await screen.findByRole('heading', { name: 'Request sent' });
    expect('note' in hub.calls(SEND)[0].body).toBe(false);
  });

  it('a filled-in trap is sent as it is, for the service to recognise', async () => {
    const hub = await ready({ [SEND]: SENT });
    await fill();
    fireEvent.change(document.querySelector('input[name="website"]'), { target: { value: 'http://spam.example' } });
    await send();
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(hub.calls(SEND)[0].body.website).toBe('http://spam.example');
  });
});

// --- what a mutation pass found ---------------------------------------------------------------------------------------------

describe('the details a mutation pass found', () => {
  const good = { guest_name: 'Asha Rao', phone: '98765 43210', party_size: '4', at: at(24, '19:30'), note: '' };

  it('a number is up to fifteen digits in any of the ways it is written, and nothing but digits and separators', () => {
    for (const phone of ['+44 1234 567890', '441234567890123', '(98765) 43210', '(+91) 98765 43210', '98765.43210', '98765-43210']) {
      expect(checkRequest({ ...good, phone }, LIMITS, NOW).errors.phone, phone).toBeUndefined();
    }
    for (const phone of ['1234567890123456', 'call 9876543210', '9876543210 ext', 'tel:9876543210', '98765_43210', '9876543210x']) {
      expect(checkRequest({ ...good, phone }, LIMITS, NOW).errors.phone, phone).toBeDefined();
    }
  });

  it('says the notice the restaurant needs in words: minutes, one hour, hours', () => {
    const say = mins => checkRequest({ ...good, at: at(23, '12:00') }, { ...LIMITS, min_notice_mins: mins }, NOW).errors.at;
    expect(say(30)).toMatch(/at least 30 minutes from now/);
    expect(say(60)).toMatch(/at least 1 hour from now/);
    expect(say(90)).toMatch(/at least 90 minutes from now/);
    expect(say(120)).toMatch(/at least 2 hours from now/);
    expect(say(180)).toMatch(/at least 3 hours from now/);
  });

  it('a note may be exactly as long as the restaurant takes, and the spaces round it do not count', () => {
    expect(checkRequest({ ...good, note: 'x'.repeat(200) }, LIMITS, NOW).errors.note).toBeUndefined();
    expect(checkRequest({ ...good, note: `  ${'x'.repeat(200)}  ` }, LIMITS, NOW).errors.note).toBeUndefined();
    expect(checkRequest({ ...good, note: 'x'.repeat(201) }, LIMITS, NOW).errors.note).toMatch(/200/);
  });

  it('the number is sent without the spaces round it', () => {
    expect(requestBody({ ...good, phone: '  98765 43210  ' }).phone).toBe('98765 43210');
  });

  it('only a whole lower-case code, at the start of the address, is a code', () => {
    expect(codeFromPath('/book/abcdefghi')).toBeNull();
    expect(codeFromPath('/book/abcdefghij')).toBe('abcdefghij');
    expect(codeFromPath('/x/book/pagecode12')).toBeNull();
    expect(codeFromPath('/book/PAGECODE12')).toBeNull();
    expect(codeFromPath('/book/PageCode12')).toBeNull();
  });

  it('if the page answers with an error it says it could not load, and does not try to read the error as a page', async () => {
    fakeHub({ [INFO]: { status: 500, body: { success: false } } });
    render(<ReservePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this page/i);
    expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
  });

  it('asks for the page afresh each time, never from a cache', async () => {
    const hub = await ready();
    expect(hub.calls(INFO)[0].init.cache).toBe('no-store');
  });

  it('says nothing is wrong with a form nobody has tried to send yet', async () => {
    await ready();
    expect(screen.getByLabelText('Your name')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText(/Please tell us your name/)).not.toBeInTheDocument();
  });

  it('typing in a field clears what the service said was wrong with that field, and only that one', async () => {
    await ready({
      [SEND]: { status: 400, body: { success: false, code: 'INVALID_REQUEST', error: 'x', errors: [{ field: 'phone', message: 'Please give a phone number the restaurant can reach you on.' }, { field: 'at', message: 'Please choose a time at least 30 minutes from now. To book sooner, phone the restaurant.' }] } }
    });
    await fill();
    await send();
    await waitFor(() => expect(screen.getByLabelText('Phone number')).toHaveAttribute('aria-invalid', 'true'));
    await userEvent.type(screen.getByLabelText('Phone number'), '1');
    expect(screen.getByLabelText('Phone number')).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Day and time')).toHaveAttribute('aria-invalid', 'true');
  });

  it('a second press of Enter while the request is out sends nothing more', async () => {
    const slow = deferred();
    const hub = await ready({ [SEND]: () => slow.promise });
    await fill();
    await send();
    fireEvent.submit(document.querySelector('form'));
    expect(hub.calls(SEND)).toHaveLength(1);
    slow.resolve(SENT);
    await screen.findByRole('heading', { name: 'Request sent' });
  });

  it('a form that is not good says what is wrong and does not pretend that anything failed to send', async () => {
    await ready({ [SEND]: SENT });
    await send();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a banner from the last attempt goes away when the next attempt is started', async () => {
    let n = 0;
    await ready({ [SEND]: () => (n++ === 0 ? new TypeError('fetch failed') : SENT) });
    await fill();
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not send that/i);
    await userEvent.clear(screen.getByLabelText('Your name'));
    await send();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends its request as JSON', async () => {
    const hub = await ready({ [SEND]: SENT });
    await fill();
    await send();
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(hub.calls(SEND)[0].init.headers['Content-Type']).toBe('application/json');
  });

  it('a failure that carries a list of errors is a failure to send, not a problem with the fields', async () => {
    await ready({ [SEND]: { status: 502, body: { success: false, error: 'Please try again in a minute.', errors: [{ field: 'phone', message: 'nope' }] } } });
    await fill();
    await send();
    expect(await screen.findByRole('alert')).toHaveTextContent('Please try again in a minute.');
    expect(screen.getByLabelText('Phone number')).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('says what a note is for, and ties that to the note', async () => {
    await ready();
    expect(screen.getByLabelText(/Anything we should know/)).toHaveAccessibleDescription('A birthday, an allergy, a table you prefer.');
  });

  it('is a telephone field, so a phone offers its number pad', async () => {
    await ready();
    const phone = screen.getByLabelText('Phone number');
    expect(phone).toHaveAttribute('type', 'tel');
    expect(phone).toHaveAttribute('inputmode', 'tel');
  });
});
