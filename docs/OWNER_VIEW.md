# The owner's view: setting it up

A read-only page for an owner to see how the restaurant is doing from anywhere: sales, the till, stock, what guests said.
It reads the cloud copy the hub keeps and **changes nothing**; the database enforces that, not the page (migration 015).

**Not deployed anywhere yet.** It needs a hosted Supabase project (with migrations 001-020 applied) and a static host. The
page builds with the rest of the app (`npm run build` produces `dist/owner.html`).

## What the page can and cannot do

- It reads: the restaurant's plan and status, bills, closed shifts, stock, guest feedback. The numbers come from the hub's own
  report code, so they match the reception Sales tab.
- It shows **what the hub last sent**, and says how long ago that was. A hub that is off, or has no internet, leaves the page as
  old as its last upload; it warns when that passes six hours.
- It cannot write, and cannot read the hub's provisioning secret or anyone's PIN hash. An owner's login holds the same database
  role the hub does, so what limits it is the role in `staff_users`: any staff login of a restaurant may read that
  restaurant's rows, and only the hub's own identity (`kitchen`) may write them.
- Bookings and the walk-in queue are not on it yet.

## Turning it on for a restaurant

1. **Build the page** with the project's address and the *anon* key (both public by design):

   ```bash
   VITE_SUPABASE_URL=https://<project>.supabase.co VITE_SUPABASE_ANON_KEY=<anon key> npm run build
   ```

   Host `dist/owner.html` and `dist/assets/` on any static host. **Never put the service key anywhere in this build.**

2. **Create the owner's login** in the Supabase dashboard (Authentication, Users, add user, with an email and password, or
   invite them). Copy the user's id.

3. **Attach them to the restaurant**, in the SQL editor (the function is closed to everyone but the service key):

   ```sql
   SELECT public.provision_owner('<restaurant id>', '<user id>', 'Their Name', 'owner');   -- or 'manager'
   ```

   It is safe to run again, refuses anything but `owner` or `manager`, and refuses a login that already works for another
   restaurant (one login, one restaurant).

4. The owner opens the page and signs in. A login attached to no restaurant is told so, and that their password is fine.

## Things worth knowing

- **Pairing.** Migration 015 also fixes pairing a new hub: it looks the restaurant up by the code on its screen through
  `restaurant_for_pairing_code()`. Before it, a freshly provisioned restaurant's hub could not find its own restaurant.
- **Migration 014 first.** It states what each database role may do to each table. Without it, a tenant's own login could change
  its plan or delete its cash-ups.
- **More than 20,000 bills** in the period the page reads: it says its figures may be short rather than quietly under-counting.
- **Not covered:** an owner with more than one restaurant (a login belongs to one), password reset, and single sign-on.
