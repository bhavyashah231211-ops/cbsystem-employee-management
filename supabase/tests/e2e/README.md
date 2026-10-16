# End-to-end tests (63 API checks + 32 browser-level checks)

Runs the real `cbs-hol` function against a real PostgreSQL and PostgREST (the same pieces Supabase uses).
It was used to verify steps 1 to 4. It needs a Linux machine with PostgreSQL 16, PostgREST, Deno and Node.

1. Create an empty database `holtest`. Create roles `anon`, `authenticated`, `service_role` (bypassrls) and `authenticator`
   (login, member of those three). Run `supabase/schema.sql`. Grant `service_role` all on tables, sequences and functions in `public`.
2. Insert test bank holidays: `insert into hol_bank_holidays values ('ENG-WLS','2026-12-25','Christmas Day'),('ENG-WLS','2026-12-28','Boxing Day (substitute)');`
3. Start PostgREST with `db-uri` for `authenticator`, `db-schemas = "public"`, `db-anon-role = "anon"`, a `jwt-secret` of 32+ characters, port 3000.
4. Make a service-role JWT signed with that secret (`{"role":"service_role"}`), then run `node proxy.js` (maps `/rest/v1/...` to PostgREST on port 54321).
5. `npm i @supabase/supabase-js esbuild`, then `node build.mjs` (bundles the function with a local Supabase client) to make `fn-test.mjs`.
6. Start the function: `SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<jwt> ADMIN_KEY=test-admin-key HOL_STAFF_URL=https://example.test/staff/ HOL_BUSINESS_URL=https://example.test/business/ deno run -A fn-test.mjs`
7. `node test.mjs` against an empty database (`truncate hol_businesses cascade` between runs). The test assumes the sandbox year 2026; change the dates if you run it in another year.

Never point this at a production project.

## Browser-level test (32 checks)
`ui_test.mjs` loads the real `site/staff/index.html` and `site/business/index.html` in jsdom (set `APP_DIR` to the project folder) and clicks through them against the running function:
sign-in, dashboard, live preview, sending a request, manager inbox and approval, notifications, cancelling approved leave, changing a PIN,
the business portal, and a name containing HTML being shown as plain text.
1. `npm i jsdom` next to the other files.
2. Empty database, then `node seed.mjs > seed.json` (creates "Test Co", a manager and two employees, and allocates leave).
3. `node ui_test.mjs`.
It replaces the function address in the pages with `http://localhost:8000`.
