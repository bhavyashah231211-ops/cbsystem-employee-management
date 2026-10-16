# CBSystem - Employee Management

Start with `DEPLOY.md` (step-by-step setup: GitHub, Supabase, Cloudflare), then `STATUS.md` (what is built and what is left) and `OPERATIONS.md` (how to run it).

The product is called **CBSystem - Employee Management**. The older short names `hol_` (tables) and `cbs-hol` (function) are kept inside the system on purpose.

Multi-tenant holiday management, built on the same pattern as CBSystem Shop and PRO.

## Folders
- `supabase/schema.sql`: tables, constraints, triggers (all prefixed `hol_`)
- `supabase/functions/cbs-hol/index.ts`: Edge Function (Verify JWT OFF)
- `site/staff/index.html`: STAFF login and app: dashboard, request leave with live preview, my requests, approvals (managers and HR), notifications, change PIN
- `site/business/index.html`: BUSINESS login for owner and HR (no staff key); People screen (add employees, reset PINs), approvals for every request, notifications, change PIN
- `site/admin/index.html`: admin page that creates and manages businesses (keep behind Cloudflare Access)

## Deploy (Step 1)
1. Supabase, SQL Editor: paste `supabase/schema.sql` and run it once.
2. Edge Functions: create a function named `cbs-hol`, paste the whole of `supabase/deploy/cbs-hol.single.ts` (one file, everything bundled), switch **Verify JWT off**, deploy.
   The multi-file source in `supabase/functions/cbs-hol/` is for the CLI and for tests. If you change it, rebuild the single file with:
   `npx esbuild index.ts --bundle --format=esm --platform=neutral --external:'npm:*' --outfile=../../deploy/cbs-hol.single.ts` (run inside `supabase/functions/cbs-hol`).
3. Secrets: `ADMIN_KEY` is already set. Add `HOL_STAFF_URL` (public address of the staff page, ending `/staff/`) and `HOL_BUSINESS_URL` (ending `/business/`) so the ready-to-send message has correct links.
   If schema.sql was run before, run it again: it is safe, and it adds the sessions `portal` column and the leave transaction functions.
4. Open the admin page, connect, and press **Update bank holidays** (loads the GOV.UK feed into `hol_bank_holidays`). Repeat at least yearly.

## Quick test (replace values)
```
curl -X POST https://wviakiswsrkxhjkgmnbw.supabase.co/functions/v1/cbs-hol \
  -H "Content-Type: application/json" -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"action":"admin.create_business","name":"Test Company"}'
```
The reply contains the staff key and owner PIN (shown once) and a ready-to-send message.

## Actions available so far
admin.create_business, admin.list_businesses, admin.set_status, admin.reset_owner_pin, admin.rotate_staff_key,
admin.seed_bank_holidays, staff.login, business.login, staff.change_pin, staff.me, staff.logout, hr.create_employee, hr.reset_pin, hr.list_employees

## Logins
- Staff login: staff key + employee number + personal PIN. Allowed roles: employee, manager, hr. The OWNER account cannot use it.
- Business login: employee number (blank means OWNER) + PIN, no staff key. Allowed roles: owner, hr.
- hr.* actions only work with a business-portal session, so a staff session cannot reach them even if the person is HR.

## Tests
`calc.ts` (leave calculator) and `holidays.ts` (GOV.UK feed parser) are pure and tested by `calc.test.ts` (15 tests); `entitlement.ts` by `entitlement.test.ts` (8 tests).
`supabase/tests/functions_test.sql` exercises the database functions (allocation, submit, overlap, balance, cancel, append-only).
Run: `npx esbuild calc.test.ts --bundle --platform=node --outfile=/tmp/t.js && node --test /tmp/t.js` (inside `supabase/functions/cbs-hol`), or `deno test calc.test.ts`.

## Leave actions (Step 3)
Staff portal session (header `x-session`): `leave.types`, `leave.preview`, `leave.submit`, `leave.cancel`, `leave.my_requests`, `leave.balances`.
Business portal session: `hr.allocate_year`, `hr.allocate` (manual adjustment, note required), `hr.balances`.

Request body for preview and submit:
`{"action":"leave.submit","leave_type_code":"annual","start_date":"2027-05-10","end_date":"2027-05-14","start_half":null,"end_half":null,"hours":null,"comment":"Family holiday"}`
- Half days: single day uses `start_half` ("am" or "pm"); a longer request may use `start_half:"pm"` (starts after lunch) and/or `end_half:"am"` (ends at lunch).
- Hourly leave: single date with `hours`.

Test order with no screens yet (business login first, then staff login):
1. `admin.seed_bank_holidays` (admin page button).
2. `business.login` as OWNER, then `hr.create_employee` for a test employee.
3. `hr.allocate_year` with `{"year_label":"2026"}` (the year created when the business was made), then `hr.balances`.
4. `staff.login` as the employee, then `leave.preview`, `leave.submit`, `leave.balances`, `leave.my_requests`, `leave.cancel`.
Note: the seeded leave year is the calendar year in which the business was created. Add further years before requesting leave in them (screen planned for step 5).

## Policy rules (hol_policies.rules)
`{"leave_type":"annual","entitlement":28,"full_time_hours":37.5,"allow_negative":false,"carry_over_max":5,"carry_over_expiry":"03-31"}`
- entitlement: days for a full-time employee for a full year. Part-time employees are pro-rated by weekly hours / full_time_hours; joiners and leavers by days employed; rounded up to the nearest half day.
- allow_negative: true lets requests exceed the balance.
- carry_over_*: stored but not yet applied (planned).

## Known simplifications
- Allocation uses the schedule in force when the employee starts in the year; a mid-year schedule change is not pro-rated. Correct with `hr.allocate`.
- Irregular-hours and part-year-worker statutory accrual are not modelled. Have the policy reviewed against current UK rules.
- Re-running `hr.allocate_year` never changes an existing allocation (idempotent); use `hr.allocate` for corrections.

## Approvals (Step 4, part 1)
Managers, HR and the owner, in either portal: `approvals.inbox`, `approvals.detail`, `approvals.decide`, `approvals.delegate`, `approvals.delegations`, `approvals.remove_delegation`.
Everyone signed in: `notifications.list`, `notifications.mark_read`.
- `approvals.decide` takes `{request_id, decision: "approved" | "rejected" | "changes_requested", comment, expected_version}`. A reason is required unless approving. `expected_version` is the version shown in the inbox; if the request changed since, the call is refused with `STALE`.
- The approver can be the person's manager, a delegate of that manager (active delegation dates), or the owner/HR in the business portal. Nobody can decide their own request.
- Approving re-checks the balance and books the ledger in the same transaction. Two people deciding at once cannot book twice.
- Approved leave is cancelled by asking (`leave.cancel`); the approver then approves the cancellation, which releases the booked days. Leave that already ended cannot be cancelled this way.
- A request needing no approval is booked immediately and cancelled immediately.
- If no manager is set, the request goes to the first HR user, then the owner.

## Tests
- `supabase/tests/approvals_test.sql`: approval, rejection, stale, delegation, override and cancellation against the database functions.
- `supabase/tests/e2e/`: 63 end-to-end checks through the real function (see its README).
Run `node --test` on `calc.test.ts` and `entitlement.test.ts` as described above.

## Known gaps after step 4, part 1
- "Request changes" returns the request to draft and tells the employee; there is no edit screen yet, so the employee cancels the draft and submits a new request.
- Minimum-staffing and maximum-concurrent-absence rules are not built; the approver sees who else is away (team overlaps) but nothing is enforced.
- A request can be made for dates in the past; no rule stops it yet.
- Leave is never marked as taken (the approved-to-completed job and the booking-to-taken ledger entries are not built).
- Delegations use the database server date (UTC).
- No emails are sent; notifications appear in the app only.

## Screens (Step 4, part 2)
Staff page: Home (balances and upcoming leave), Request leave (live preview of the days charged, bank holidays skipped and the balance left; half days and hours), My requests (withdraw, or ask to cancel approved leave), Approvals (managers and HR: review with team overlaps, approve, reject or ask for changes with a reason, set cover while away), Notifications (with an unread count), My PIN.
Business page: People, Approvals (every pending request in the business), Notifications, My PIN.
All text from the server is inserted as plain text, never as HTML.
Tested: `supabase/tests/e2e/ui_test.mjs` (32 checks in a simulated browser). Not tested on real phones or in real browsers; please try both pages on your own phone.

## Step 6 notes
- Past dates: staff cannot start a request before today (business time zone). A policy can allow up to N days back (`backdate_days`). HR has no "record past leave for someone" action yet; use a balance adjustment with a note.
- Team cover limit: set per department in Setup. Staff see a warning in the preview, the approver sees the breach and must confirm to go over. It counts approved leave only and is checked when approving. Two approvers acting at the very same moment could both pass the check; it is a guide, not a lock.
- Calendar: employees see people with the same manager (or department), managers see their team, the business portal sees everyone. Pending requests are visible only to the person, their manager and the business portal. Leave types are never shown to colleagues.
- Changing a request withdraws the old one and creates the new one in a single transaction, so a failed change never loses the original.

## Step 7 notes
- Business portal only: Home (people, waiting requests, who is away today, next 14 days), Reports (balances per year and department; absence by date range and status; both download as CSV), Audit log (filter by kind, person and dates; 50 per page; download the rows shown).
- The audit log is append-only in the database. Platform actions made from the admin page appear as "admin-console".
- The audit filter parameter is `action_prefix` (the request field `action` is the endpoint name).
- Reports read straight from the ledger, so they always agree with the balances people see.

## Step 8 notes
- Taken leave: once an approved request's last day has passed (in the business time zone) the daily job marks it Completed and moves the days from booked to taken. Completed leave cannot be cancelled.
- Carry-over: Setup, "Carry over unused leave" (or `hr.carry_over`). Up to the policy's `carry_over_max`, in half days, rounded down. Carried days expire after the policy's `carry_over_expiry` date (MM-DD in the new year); days taken up to that date count against the carried days first.
- Sickness: employees tell their manager from Home ("I am off sick today", "I am back at work"). HR records absences with a private reason and note in the business portal's Sickness tab. Managers see dates, colleagues see only "away", the audit log and emails never contain the reason. Sickness does not use up leave. The calendar and the sickness report count Monday to Friday only, not each person's own schedule.
- Email: set the secrets `EMAIL_API_KEY`, `EMAIL_FROM` and optionally `EMAIL_API_URL` (default is the Resend API, `https://api.resend.com/emails`). The owner switches it on in Setup. People need an email address on their record. Every in-app notification is also emailed; failures are retried on the next run.
- Daily jobs: call `admin.run_jobs` (admin key) once a day, and every 15 minutes for email. In Supabase, enable the pg_cron and pg_net extensions and run:
```
select cron.schedule('hol-jobs', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/cbs-hol',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-admin-key', 'YOUR_ADMIN_KEY'),
    body := '{"action":"admin.run_jobs"}'::jsonb);
$$);
```
  (The job is safe to run as often as you like. Prefer Supabase Vault to hold the key rather than writing it into the schedule.) Without a schedule nothing is marked taken, carried leave never expires and no email is sent.
- The pages use the business time zone for "today". An earlier version used UTC, which was wrong for the first hour of the day in summer.

## Step 9 notes
- Throttling: after 20 failed sign-ins for one business from one address, that address is paused for 15 minutes; 300 failures across a business pause it for 15 minutes; 20 wrong admin keys pause that address. The pause blocks correct details too, until the 15 minutes pass. The address used is the last one in `x-forwarded-for` (or `cf-connecting-ip` when present).
- CORS: set the secret `HOL_ALLOWED_ORIGINS` (comma-separated page addresses). Until then any website may call the function. Responses are never cached.
- Requests over 2 MB are refused.
- GDPR: `hr.export_employee` (JSON of everything held), `hr.anonymise_employee` (only after someone has left), automatic anonymising after the retention period set in Setup. `admin.reconcile` checks cached balances against the ledger (and repairs them with `"fix": true`).
- `supabase/tests/e2e/test9.mjs` includes a sweep that tries every action that takes an id or an employee number with another business's session, then checks nothing in the first business changed. Employee numbers are separate per business, so two businesses can both have an "E1".
