import crypto from 'crypto';

// A guest's phone number: storing it, reaching them on it, and recognising them by it.
//
// Shared by reservations, the waitlist and loyalty, because in a restaurant they are all the same
// person and the number is the only thing that ties the three together.
//
// It is personal data, so what is kept is deliberately split:
//
//   `phone`  the number itself, because staff have to be able to ring a guest whose table is ready;
//   `phone_key` a hash, which is what is MATCHED on. Loyalty never needs to read a number back, only
//            to know it is the same person -- so the thing that accumulates a visit history keys on
//            something that cannot be read out of a stolen file.
//
// India-first, because the pilot is in Nagpur and every number staff type is a local 10-digit mobile.
// Other countries work when typed in full with a `+`.

const DEFAULT_COUNTRY_CODE = '91';

/**
 * A typed number as digits with a country code, or null if it cannot be one.
 *
 * Staff type numbers in every shape there is: `98765 43210`, `+91 98765-43210`, `098765 43210`. All
 * of those are one guest, and a loyalty history split across three spellings of the same number is
 * worse than none.
 */
export function normalizePhone(input, { defaultCountryCode = DEFAULT_COUNTRY_CODE } = {}) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const hadPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) {
    // Typed in full. Shortest usable international number is about 8 digits; longest E.164 is 15.
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }
  // A local Indian mobile, with or without the trunk 0.
  const local = digits.replace(/^0+/, '');
  if (local.length === 10) return `${defaultCountryCode}${local}`;
  // Already carries a country code, typed without the plus.
  if (local.length > 10 && local.length <= 15) return local;
  return null;
}

/** "+91 98765 43210" — what staff read back to a guest to check they have it right. */
export function formatPhone(normalized) {
  if (!normalized) return '';
  if (normalized.startsWith(DEFAULT_COUNTRY_CODE) && normalized.length === 12) {
    const local = normalized.slice(2);
    return `+${DEFAULT_COUNTRY_CODE} ${local.slice(0, 5)} ${local.slice(5)}`;
  }
  return `+${normalized}`;
}

/**
 * The key a guest is matched on across visits.
 *
 * Salted with the restaurant's own id, so the same number at two restaurants produces two unrelated
 * keys: one tenant's guest list can never be joined against another's, and a leaked key is not a
 * number anybody can look up.
 */
export function phoneKey(normalized, restaurantId) {
  if (!normalized) return null;
  return crypto.createHash('sha256').update(`${restaurantId ?? ''}:${normalized}`).digest('hex');
}

/** Both at once, for storing a guest. `{ phone, phone_key }`, or null when the number is unusable. */
export function guestContact(input, restaurantId) {
  const phone = normalizePhone(input);
  return phone ? { phone, phone_key: phoneKey(phone, restaurantId) } : null;
}

/**
 * A click-to-chat link: tapping it opens WhatsApp on the STAFF member's own phone, with the message
 * already typed, addressed to the guest.
 *
 * Chosen over the WhatsApp Business API deliberately. The API sends by itself, and needs Meta
 * approval, a provider, approved message templates and a per-message fee. This needs none of those
 * and works today -- the cost is that a person has to press send, which in a restaurant that is
 * about to seat someone is not really a cost.
 */
export function whatsappLink(normalized, message) {
  if (!normalized) return null;
  const text = String(message ?? '').trim();
  return `https://wa.me/${normalized}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** A plain `tel:` link, for staff who would rather just ring them. */
export const telLink = normalized => (normalized ? `tel:+${normalized}` : null);
