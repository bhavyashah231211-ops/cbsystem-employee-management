# CBSystem - Employee Management - operations guide

How to deploy, run, back up, update and secure the system. Read `STATUS.md` for what is and is not built.

## 1. What you are running
- **Database**: your Supabase project, tables prefixed `hol_` (`supabase/schema.sql`). Safe to re-run at any time.
- **Function**: one Edge Function `cbs-hol` (Verify JWT off). Paste `supabase/deploy/cbs-hol.single.ts`.
- **Pages** (the `site` folder): `site/staff/`, `site/business/` (customers) and `site/admin/` (you only). Plain static files, published by Cloudflare Pages with output directory `site`.
- Customers never see Supabase. Everything goes through the function, which holds the only key that can read the tables.

## 2. First-time setup (in order)
1. SQL Editor: run `supabase/schema.sql`.
2. Create the function `cbs-hol`, paste the single file, **Verify JWT off**, deploy.
3. Add the secrets below.
4. Publish the `site` folder (see `DEPLOY.md`). Put `/admin` behind Cloudflare Access (email code) so only you can open it.
5. Open the admin page, connect, press **Update bank holidays**.
6. Create a test business, sign in on both pages, request and approve a leave day, then delete nothing (use **Close** to retire it).
7. Turn on the schedule (section 5).
8. Do the restore drill once (section 6) before the first paying customer.

## 3. Secrets
| Secret | Needed | Meaning |
|---|---|---|
| `ADMIN_KEY` | yes | Your platform key for the admin page. Long and random. |
| `HOL_STAFF_URL` | yes | Public address of the staff page, ending `/staff/` |
| `HOL_BUSINESS_URL` | yes | Public address of the business page, ending `/business/` |
| `HOL_ALLOWED_ORIGINS` | **set before selling** | Comma-separated page addresses allowed to call the function, e.g. `https://holiday.example.co.uk`. If empty, any website may call it. |
| `EMAIL_API_KEY`, `EMAIL_FROM` | for email | Resend (or compatible) key and verified sender address |
| `EMAIL_API_URL` | optional | Defaults to `https://api.resend.com/emails` |

## 4. Looking after customers
- **New customer**: admin page, Create a business, send them the message (staff key and owner PIN are shown once).
- **Lost owner PIN / leaked staff key**: admin page, Reset owner PIN / New staff key.
- **Stop access**: Suspend (signs everyone out; data kept). Close retires it. There is deliberately no delete.
- **Locked person**: five wrong PINs lock one person for 15 minutes; HR can reset their PIN. Repeated wrong sign-ins from one address also pause that address for 15 minutes.

## 5. Scheduled jobs (required)
Without these nothing becomes "taken", carried leave never expires, retention never runs and no email is sent.
Enable the pg_cron and pg_net extensions, then (use Supabase Vault for the key where you can):
```
select cron.schedule('hol-jobs', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/cbs-hol',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-admin-key', 'YOUR_ADMIN_KEY'),
    body := '{"action":"admin.run_jobs"}'::jsonb);
$$);
```
Running it often is safe. Check it ran: Database, Cron, job history; the function logs show errors.

**Weekly check**: call `admin.reconcile` (admin page does not have a button; use curl). It must report `mismatches: 0`. If not, call it with `"fix": true` and tell me, because it means something wrote a balance without the ledger.
```
curl -X POST https://YOUR-PROJECT.supabase.co/functions/v1/cbs-hol -H "Content-Type: application/json" -H "x-admin-key: YOUR_ADMIN_KEY" -d '{"action":"admin.reconcile"}'
```

## 6. Backups and the restore drill
- Supabase free projects have **no** automatic backups. Use a paid plan with daily backups (point-in-time recovery if you can), or schedule your own `pg_dump` of the `public` schema to storage you control.
- **Drill (do this once, then every few months)**: create an empty scratch project; restore the latest backup into it (or `psql < dump.sql`); run `supabase/schema.sql` again (safe); run the SQL below; then point a copy of the function at the scratch project and sign in as a test business. Write down how long it took.
```
select count(*) from hol_businesses; select count(*) from hol_employees; select count(*) from hol_ledger;
select * from hol_reconcile_balances();   -- must return no rows
```
- Never test a restore on the live project.

## 7. Updating
1. Take a backup.
2. Run the new `schema.sql` (it only adds or replaces; it never deletes data).
3. Paste the new single-file function and deploy.
4. Upload the page folders.
5. Run one request and one approval on a test business.
Keep the previous function file so you can paste it back.

## 8. Security checklist
- [ ] `/admin` behind Cloudflare Access; `HOL_ALLOWED_ORIGINS` set; `ADMIN_KEY` long and unique
- [ ] Two-factor on your Supabase, GitHub, Cloudflare and domain accounts
- [ ] The public (anon) key cannot read tables: `set role anon; select count(*) from hol_employees;` must say permission denied
- [ ] Function has Verify JWT **off** on purpose; nothing else is exposed
- [ ] Test businesses closed, no test PINs in use
- [ ] Backups enabled and the restore drill done
- [ ] Staff and owner PINs were handed over once and not kept in chat history
- Pages use inline scripts, so a strict content-security policy is not possible without changing them. Serve over HTTPS only.

## 9. Personal data (UK GDPR)
- **Subject access**: People, Export data (JSON of everything held on that person).
- **Erasure / leaver clean-up**: People, mark as left, then Anonymise. It removes name, email, notes, absence reasons and their notifications and keeps leave totals. Free text a user typed into balance-adjustment notes and the audit log is kept (those records are append-only by design); avoid putting personal details in notes.
- **Retention**: Setup, Data retention sets an automatic period after leaving.
- **Sickness**: reasons are visible to HR only; they never appear in audit entries, emails or colleagues' views.
- You still need: privacy notice, a data processing agreement with each customer, a record of processing, and advice on retention periods. This guide is not legal advice.

## 10. Incidents
1. Contain: Suspend the business, or rotate its staff key; reset PINs if needed.
2. Find: the Audit log (business portal) and the function logs show who did what.
3. Recover: restore from backup into a scratch project first.
4. Tell people: a personal data breach may have to be reported to the ICO within 72 hours. Take advice.

## 11. Limits you should know
- Not load tested. The browser and API tests (452 checks) prove behaviour, not capacity. Pilot with one or two real customers before selling widely.
- Importing employees hashes a PIN per person, so the import runs in batches of 50.
- The team cover limit, sickness weekday counts and the calendar are approximate in the ways described in `README.md`.
- Edge Functions have time and CPU limits; very large businesses (1,000+ people) may need the yearly allocation run in parts.
