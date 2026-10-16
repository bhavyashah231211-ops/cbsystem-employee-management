# CBSystem - Employee Management - build status (all nine planned steps are built)

To put it online, follow `DEPLOY.md`.

Read this first. See `OPERATIONS.md` to run it and `README.md` for details of each feature.

## Built and tested
1. Database, `cbs-hol` function, business creation, separate staff and business logins
2. Admin, staff and business pages
3. Leave calculator, bank holidays (GOV.UK feed), requests, balances, yearly allocation
4. Approvals, delegation, cancelling approved leave, notifications, change PIN
5. Business setup: leave years, policies, schedules, leave types, bank holiday changes, balance adjustments, employee edit and leavers, CSV import
6. Team calendar, team cover limits, no requests in the past, change-and-resubmit
7. Reports (balances, absence), audit log, CSV downloads, home summary
8. Leave marked as taken, carry-over and expiry, sickness (reason private to HR), email, daily jobs
9. Login throttling, CORS allow-list, GDPR export / anonymise / retention, balance reconciliation, cross-business isolation sweep, operations guide

## Tests (all pass): 452 checks + unit tests
- API through the real function and PostgreSQL 16: 63 + 57 + 42 + 35 + 58 + 91 = 346 (`supabase/tests/e2e/test*.mjs`)
- Browser-level (real pages in a simulated browser): 32 + 19 + 15 + 16 + 15 + 9 = 106 (`ui*_test.mjs`)
- Pure logic: 15 calculator + 8 entitlement; database function tests in `supabase/tests/*.sql`

## NOT tested here (needs your own setup)
- Real Supabase hosting (tests ran on PostgreSQL 16 + PostgREST 12 + Deno 2.1 here, the same building blocks)
- Real phones and browsers (layout, touch). Try both pages on your phone.
- pg_cron / pg_net scheduling, a real email provider (tested only against a mock), the Cloudflare Access setup
- Load: never load tested. Pilot with one or two real customers first.

## Features NOT built
- More than one approval step (the database allows it; the screens and rules use one approver)
- Outlook / Google calendar sync, payroll integration, a mobile app
- Accrual-based entitlement (leave earned over the year) and TOIL earning; irregular-hours and part-year-worker statutory methods
- HR booking leave on someone's behalf, and recording past leave (use a balance adjustment with a note)
- Sick note attachments, Bradford factor, charts
- Staff sign-in is a 6-digit PIN plus a shared staff key; there is no email/password, single sign-on or two-step sign-in for staff
- Branding per customer, languages other than English (UK), a formal accessibility audit
- Admin page buttons for jobs and reconcile (use curl, see `OPERATIONS.md`)

## Known limits (documented, accepted for now)
- Team cover limit is checked when approving, not locked; two approvers at the same instant could both pass
- Calendar and sickness counts treat Monday to Friday as working days, not each person's own schedule
- Free text typed into balance notes and held in the append-only audit log cannot be anonymised
- Delegation dates in the database use UTC
- A mid-year schedule change is not pro-rated in the yearly allocation (correct with a balance adjustment)

## Needs a professional (not code)
- Statutory leave rules for your customers' situations (irregular hours, part-year, sickness during leave)
- UK GDPR: privacy notice, processing agreements, retention periods
- Terms and Privacy pages, insurance, pricing, support process
