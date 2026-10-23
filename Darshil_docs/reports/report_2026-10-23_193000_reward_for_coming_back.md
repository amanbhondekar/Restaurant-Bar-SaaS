# A reward for coming back

**Date:** 2026-10-23T19:30:00+05:30 · **Branch:** `feat/m2-kitchen-ops`

## WHY AND WHAT IT IS NOT
Roadmap §4.5 carried "no reward scheme (points, free dishes, tiers)". The loyalty module says why, in its own header: how generous to
be is a commercial decision, and inventing one would be the wrong kind of guess. So this is **not** a scheme the product chooses. It
is a rule the **restaurant** sets, off until it does, and the hub only does what a hub can do honestly: tell the host at the right
moment, and remember that it was given.

Not built: points, tiers, and any automatic discount. The reward is applied on the bill by a person, because the product does not know
what a dessert costs or how much the owner will give.

## WHAT CHANGED
- **The rule** (`lib/loyalty.js`, `normalizeRewardScheme`): a whole number of visits from 2 to 50 ("every visit" is not a reward) and
  wording of 1 to 80 characters ("a free dessert", "10% off the bill"). Anything else is no scheme. A number typed into a form
  arrives as text and is accepted; wording that will not fit is refused rather than cut, because half a sentence on a host's screen is
  worse than an error on the settings form.
- **When a visit earns it** (`rewardDue`): the guest's Nth, 2Nth, 3Nth visit. Only seated visits count (bookings **and** walk-ins that sat
  down; not cancellations, no-shows, a party that gave up, or other guests), the booking is not counted as its own earlier visit, and a
  reward already given is not offered again.
- **Giving it** (`reservations.js`, `giveReward` / `takeBackReward`): records when, the words that were promised and which visit it was,
  so changing the rule later does not rewrite what a guest was told. It cannot be given at will: `NOT_DUE` if the visit has not earned it,
  `REWARDS_OFF` with no rule, `NOT_FOUND`. Giving it twice changes nothing; it can be taken back.
- **Routes** (all reception-only): `GET` and `PUT /admin/rewards`, `POST` and `DELETE /admin/bookings/:id/reward`; the diary list says
  `reward_due` on a booking that earns it. The rule lives in the hub's config, like guest ordering.
- **Cloud**: migration `017_reservation_rewards.sql` (three nullable columns on `reservations`), pushed and restored with the diary, so a
  replacement laptop does not offer a guest the same reward twice. The rule itself is a hub setting and is not replicated.
- **Bookings tab**: a "5th visit: a free dessert" badge and a **Reward given** button on the booking, "Reward given: a free dessert" and
  **Take back** afterwards; a **Rewards** panel (off: what the product does and does not do and a form; on: the rule with Change and
  Turn off). Changing the rule reads the diary again.

## TESTS
- `rewards.test.mjs` (18): the rule's every boundary (2 and 50 in, 1 and 51 out, 80 characters in and 81 out, text and non-numbers),
  which visits are due (5th, 10th, 15th, nothing in between, the restaurant's own N, only seated visits, a seated walk-in counts and one
  in the queue or that left does not, other guests do not), no rule or a booking that is not coming up, not offered again once given, a
  booking already seated; giving it (when, words, visit, immutability of the old state, refusals, twice, taking back); and on real hubs
  the settings round trip and refusal, the diary naming the 3rd-visit booking and a first-timer getting nothing, give, show, take back,
  the refusals, the scheme off, and a handset getting `RECEPTION_ONLY` on every route.
- `cloudRoundTrip.test.mjs`: a booking with the reward fields goes to the real database engine and comes back identical.
- `RewardsPanel.test.jsx` (9) and `BookingsTab.test.jsx` (+8): the wording helpers, what the panel says, nothing saved until it is right
  (and each error named), turning on sends a number and trimmed words, Change starts from the current rule, Cancel changes nothing,
  Turn off, the hub's refusal said in its words, an unreachable hub, and on the diary the badges, the buttons, the refusals and the
  diary being read again when the rule changes.

**Mutation check:** 44 on the hub and 36 on the UI. The first pass left three on the hub (the exact 80-character boundary, whether a
seated walk-in counts, and one equivalent: a booking with no recognition key can never be due either way) and five on the UI (the
form after Turn off, Enter in an invalid form, an error test that matched the hint text instead of the error, Cancel while changing, the
upper bound of 50). Seven were real gaps and are closed; the reset after Turn off was redundant and removed; the Enter-submit guard is
equivalent under test (a disabled submit button already blocks implicit submission) and kept as a cheap safety.

## A FLAKE, ROOT-CAUSED
A real-hub assertion that a timestamp the hub wrote was `<= Date.now()` failed once. On Windows two processes' clocks can differ by a
tick (about 15 ms), so a time the hub wrote a moment ago can look slightly in the future to the test. The same assertion was in my
reminders test. Both now allow two seconds of skew. The rewards test also assumed a booking a few hours ahead lands in *today's*
diary, which is false late in the evening; it now looks each booking up in its own day.

## COUNTS
Hub **1333 passing** across 67 files (1315 before); frontend **875** (858); build clean.

## NOT DONE
- Points, tiers and automatic discounts. A person applies the reward on the bill; the hub does not know the bill belongs to this guest.
- Walk-ins count as visits but are not *offered* the reward, only bookings (a walk-in is standing at the door and has no booking row).
- The rule is a hub setting, not replicated; a replacement laptop starts with no rule (the given rewards are restored).
- The Rewards panel says nothing about who is allowed to change the rule: anyone at the reception laptop can (the manager-PIN question).
- Migration 017 has not run on a hosted project; it has run, twice, on the real Postgres engine in the tests.
