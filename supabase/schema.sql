-- =====================================================================
-- CBSystem - Employee Management - schema.sql  (Step 1, Part 1 of 2)
-- Multi-tenant: one Supabase project, many businesses.
-- All tables are prefixed hol_ so they never collide with Shop / PRO / Pet Care.
-- All access goes through the Edge Function `cbs-hol` (service role).
-- RLS is enabled with NO policies: anon and authenticated keys see nothing.
-- Safe to re-run: uses IF NOT EXISTS where possible.
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- 1. Businesses (tenants)
-- ---------------------------------------------------------------------
create table if not exists hol_businesses (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  status          text not null default 'active'
                    check (status in ('active','suspended','closed')),
  plan            text not null default 'standard',
  region          text not null default 'ENG-WLS'
                    check (region in ('ENG-WLS','SCT','NIR')),
  timezone        text not null default 'Europe/London',
  staff_key_hash  text not null,          -- shared staff link key, shown once
  owner_pin_hash  text not null,          -- owner / HR console PIN
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Departments, employees
-- ---------------------------------------------------------------------
create table if not exists hol_departments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references hol_businesses(id),
  name          text not null,
  created_at    timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, name)
);

create table if not exists hol_employees (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references hol_businesses(id),
  employee_number  text not null,
  full_name        text not null,
  email            text,
  role             text not null default 'employee'
                     check (role in ('employee','manager','hr','owner')),
  department_id    uuid,
  manager_id       uuid,
  calendar_code    text check (calendar_code in ('ENG-WLS','SCT','NIR')), -- null = business region
  pin_hash         text,
  pin_attempts     integer not null default 0 check (pin_attempts >= 0),
  locked_until     timestamptz,
  employment_start date not null,
  employment_end   date,
  status           text not null default 'active'
                     check (status in ('active','terminated')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, employee_number),
  foreign key (business_id, department_id) references hol_departments(business_id, id),
  foreign key (business_id, manager_id)    references hol_employees(business_id, id),
  check (employment_end is null or employment_end >= employment_start),
  check (manager_id is null or manager_id <> id)
);
create index if not exists idx_hol_emp_manager on hol_employees (business_id, manager_id);

-- Sessions issued by the Edge Function after staff key + employee PIN
create table if not exists hol_sessions (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references hol_businesses(id),
  employee_id   uuid not null,
  token_hash    text not null unique,
  portal        text not null default 'staff' check (portal in ('staff','business')),
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  foreign key (business_id, employee_id) references hol_employees(business_id, id)
);
create index if not exists idx_hol_sessions_exp on hol_sessions (expires_at);
-- for projects where schema.sql was already run before staff and business logins were separated:
alter table hol_sessions add column if not exists portal text not null default 'staff' check (portal in ('staff','business'));

-- ---------------------------------------------------------------------
-- 3. Work schedules and assignments (no overlapping periods)
-- ---------------------------------------------------------------------
create table if not exists hol_work_schedules (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references hol_businesses(id),
  name          text not null,
  -- {"mon":7.5,"tue":7.5,"wed":7.5,"thu":7.5,"fri":7.5,"sat":0,"sun":0}  hours per weekday
  week_pattern  jsonb not null,
  created_at    timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, name)
);

create table if not exists hol_schedule_assignments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null,
  employee_id   uuid not null,
  schedule_id   uuid not null,
  effective_from date not null,
  effective_to   date,
  foreign key (business_id, employee_id) references hol_employees(business_id, id),
  foreign key (business_id, schedule_id) references hol_work_schedules(business_id, id),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (
    business_id with =, employee_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);

-- ---------------------------------------------------------------------
-- 4. Leave years, leave types, versioned policies
-- ---------------------------------------------------------------------
create table if not exists hol_leave_years (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references hol_businesses(id),
  label         text not null,
  starts_on     date not null,
  ends_on       date not null,
  unique (business_id, id),
  unique (business_id, label),
  check (ends_on > starts_on),
  exclude using gist (
    business_id with =, daterange(starts_on, ends_on, '[]') with &&
  )
);

create table if not exists hol_leave_types (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references hol_businesses(id),
  code              text not null,
  name              text not null,
  unit              text not null default 'days' check (unit in ('days','hours')),
  balance_tracked   boolean not null default true,
  requires_approval boolean not null default true,
  is_sickness       boolean not null default false,   -- routed to hol_absence_records
  active            boolean not null default true,
  unique (business_id, id),
  unique (business_id, code)
);

create table if not exists hol_policies (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references hol_businesses(id),
  name           text not null,
  version        integer not null,
  status         text not null default 'draft' check (status in ('draft','active','retired')),
  effective_from date not null,
  effective_to   date,
  -- e.g. {"leave_type":"annual","entitlement":28,"accrual":"upfront",
  --       "carry_over_max":5,"carry_over_expiry":"03-31","bank_holidays_included":true}
  rules          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, name, version),
  check (effective_to is null or effective_to >= effective_from)
);

create table if not exists hol_policy_assignments (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null,
  employee_id    uuid not null,
  policy_id      uuid not null,
  effective_from date not null,
  effective_to   date,
  foreign key (business_id, employee_id) references hol_employees(business_id, id),
  foreign key (business_id, policy_id)   references hol_policies(business_id, id),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (
    business_id with =, employee_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);

-- ---------------------------------------------------------------------
-- 5. Public holidays: GLOBAL regional calendars + per-business overrides
--    Seed hol_bank_holidays from https://www.gov.uk/bank-holidays.json
-- ---------------------------------------------------------------------
create table if not exists hol_bank_holidays (
  calendar_code text not null check (calendar_code in ('ENG-WLS','SCT','NIR')),
  holiday_date  date not null,
  name          text not null,
  primary key (calendar_code, holiday_date)
);

create table if not exists hol_holiday_overrides (
  business_id   uuid not null references hol_businesses(id),
  calendar_code text not null check (calendar_code in ('ENG-WLS','SCT','NIR')),
  holiday_date  date not null,
  name          text not null,
  is_working_day boolean not null default false,  -- true = remove a bank holiday; false = add a shutdown day
  primary key (business_id, calendar_code, holiday_date)
);

-- ---------------------------------------------------------------------
-- 6. Requests, charged days, approvals
-- ---------------------------------------------------------------------
create table if not exists hol_requests (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null,
  employee_id      uuid not null,
  leave_type_id    uuid not null,
  policy_id        uuid,
  start_date       date not null,
  end_date         date not null,
  start_half       text check (start_half in ('am','pm')),   -- null = full day
  end_half         text check (end_half in ('am','pm')),
  requested_units  numeric(10,4) not null check (requested_units > 0),
  status           text not null default 'pending'
                     check (status in ('draft','pending','approved','rejected',
                                       'cancelled','cancellation_pending','completed')),
  comment          text,
  policy_snapshot  jsonb not null default '{}'::jsonb,
  version          integer not null default 1,
  submitted_at     timestamptz,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, employee_id)   references hol_employees(business_id, id),
  foreign key (business_id, leave_type_id) references hol_leave_types(business_id, id),
  foreign key (business_id, policy_id)     references hol_policies(business_id, id),
  check (end_date >= start_date),
  -- one live request per employee per date range (split half-days on the same date are a known limitation)
  exclude using gist (
    business_id with =, employee_id with =,
    daterange(start_date, end_date, '[]') with &&
  ) where (status in ('pending','approved','cancellation_pending'))
);
create index if not exists idx_hol_req_emp     on hol_requests (business_id, employee_id, start_date desc);
create index if not exists idx_hol_req_pending on hol_requests (business_id, status, submitted_at) where status = 'pending';
create index if not exists idx_hol_req_dates   on hol_requests (business_id, start_date, end_date);

create table if not exists hol_request_days (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null,
  request_id     uuid not null,
  leave_year_id  uuid not null,
  leave_date     date not null,
  units          numeric(10,4) not null check (units > 0),
  created_at     timestamptz not null default now(),
  unique (business_id, request_id, leave_date),
  foreign key (business_id, request_id)    references hol_requests(business_id, id),
  foreign key (business_id, leave_year_id) references hol_leave_years(business_id, id)
);
create index if not exists idx_hol_days_date on hol_request_days (business_id, leave_date);

create table if not exists hol_approval_steps (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null,
  request_id       uuid not null,
  step_number      integer not null check (step_number > 0),
  approver_id      uuid not null,
  status           text not null default 'pending'
                     check (status in ('pending','approved','rejected','skipped')),
  decided_at       timestamptz,
  unique (business_id, id),
  unique (business_id, request_id, step_number),
  foreign key (business_id, request_id)  references hol_requests(business_id, id),
  foreign key (business_id, approver_id) references hol_employees(business_id, id)
);
create index if not exists idx_hol_inbox on hol_approval_steps (business_id, approver_id, status);

create table if not exists hol_approval_decisions (       -- append-only history
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null,
  step_id       uuid not null,
  actor_id      uuid not null,
  decision      text not null check (decision in ('approved','rejected','changes_requested')),
  comment       text,
  created_at    timestamptz not null default now(),
  foreign key (business_id, step_id)  references hol_approval_steps(business_id, id),
  foreign key (business_id, actor_id) references hol_employees(business_id, id)
);

create table if not exists hol_delegations (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null,
  from_id       uuid not null,
  to_id         uuid not null,
  starts_on     date not null,
  ends_on       date not null,
  foreign key (business_id, from_id) references hol_employees(business_id, id),
  foreign key (business_id, to_id)   references hol_employees(business_id, id),
  check (ends_on >= starts_on),
  check (from_id <> to_id)
);

-- ---------------------------------------------------------------------
-- 7. Sickness records: separate table, HR-only through the function layer
-- ---------------------------------------------------------------------
create table if not exists hol_absence_records (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null,
  employee_id   uuid not null,
  starts_on     date not null,
  ends_on       date,
  reason_code   text,                 -- coarse category visible to managers
  details       text,                 -- sensitive: HR only
  recorded_by   uuid,
  created_at    timestamptz not null default now(),
  foreign key (business_id, employee_id) references hol_employees(business_id, id),
  foreign key (business_id, recorded_by) references hol_employees(business_id, id),
  check (ends_on is null or ends_on >= starts_on)
);

-- ---------------------------------------------------------------------
-- 8. Ledger (append-only) and cached balance rows (lockable, reconcilable)
-- Sign convention, enforced:
--   positive: allocation, accrual, carry_over, release
--   negative: booking, taken, expiry
--   either:   adjustment, reversal
-- Booking converts to taken as: release (+x) then taken (-x). Available = SUM(quantity).
-- ---------------------------------------------------------------------
create table if not exists hol_ledger (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null,
  employee_id     uuid not null,
  leave_type_id   uuid not null,
  leave_year_id   uuid not null,
  request_id      uuid,
  entry_type      text not null check (entry_type in
                    ('allocation','accrual','carry_over','release','booking',
                     'taken','expiry','adjustment','reversal')),
  quantity        numeric(12,4) not null,
  effective_date  date not null,
  idempotency_key text not null,
  reversal_of     uuid,
  note            text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, idempotency_key),
  foreign key (business_id, employee_id)   references hol_employees(business_id, id),
  foreign key (business_id, leave_type_id) references hol_leave_types(business_id, id),
  foreign key (business_id, leave_year_id) references hol_leave_years(business_id, id),
  foreign key (business_id, request_id)    references hol_requests(business_id, id),
  foreign key (business_id, reversal_of)   references hol_ledger(business_id, id),
  check (quantity <> 0),
  check (
    (entry_type in ('allocation','accrual','carry_over','release') and quantity > 0) or
    (entry_type in ('booking','taken','expiry') and quantity < 0) or
    (entry_type in ('adjustment','reversal'))
  )
);
create index if not exists idx_hol_ledger_emp on hol_ledger
  (business_id, employee_id, leave_type_id, leave_year_id, effective_date);

-- One row per employee / leave type / year. Lock it with SELECT ... FOR UPDATE
-- before posting ledger entries, then refresh cached_available from the ledger.
create table if not exists hol_balances (
  business_id      uuid not null,
  employee_id      uuid not null,
  leave_type_id    uuid not null,
  leave_year_id    uuid not null,
  cached_available numeric(12,4) not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (business_id, employee_id, leave_type_id, leave_year_id),
  foreign key (business_id, employee_id)   references hol_employees(business_id, id),
  foreign key (business_id, leave_type_id) references hol_leave_types(business_id, id),
  foreign key (business_id, leave_year_id) references hol_leave_years(business_id, id)
);

-- ---------------------------------------------------------------------
-- 9. Audit, notifications, outbox
-- ---------------------------------------------------------------------
create table if not exists hol_audit_log (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references hol_businesses(id),
  actor_id      uuid,
  actor_label   text,                  -- e.g. 'admin-console' for platform actions
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  changes       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  foreign key (business_id, actor_id) references hol_employees(business_id, id)
);
create index if not exists idx_hol_audit_entity on hol_audit_log (business_id, entity_type, entity_id, created_at desc);

create table if not exists hol_notifications (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null,
  employee_id   uuid not null,
  title         text not null,
  body          text,
  request_id    uuid,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (business_id, employee_id) references hol_employees(business_id, id)
);
create index if not exists idx_hol_notif_emp on hol_notifications (business_id, employee_id, created_at desc);

create table if not exists hol_outbox (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references hol_businesses(id),
  event_type    text not null,
  aggregate_id  uuid,
  payload       jsonb not null default '{}'::jsonb,
  attempts      integer not null default 0 check (attempts >= 0),
  last_error    text,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);
create index if not exists idx_hol_outbox_open on hol_outbox (created_at) where processed_at is null;

-- ---------------------------------------------------------------------
-- 10. Integrity triggers
-- ---------------------------------------------------------------------
-- Append-only tables
create or replace function hol_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'Table % is append-only', tg_table_name;
end $$;

drop trigger if exists trg_hol_ledger_immutable on hol_ledger;
create trigger trg_hol_ledger_immutable before update or delete on hol_ledger
  for each row execute function hol_block_mutation();

drop trigger if exists trg_hol_audit_immutable on hol_audit_log;
create trigger trg_hol_audit_immutable before update or delete on hol_audit_log
  for each row execute function hol_block_mutation();

drop trigger if exists trg_hol_decisions_immutable on hol_approval_decisions;
create trigger trg_hol_decisions_immutable before update or delete on hol_approval_decisions
  for each row execute function hol_block_mutation();

-- Request total must equal the sum of charged days (checked at commit)
create or replace function hol_check_request_total() returns trigger
language plpgsql as $$
declare
  rid uuid; bid uuid; req_units numeric; req_status text; day_sum numeric;
begin
  if tg_table_name = 'hol_requests' then
    rid := new.id; bid := new.business_id;
  else
    rid := new.request_id; bid := new.business_id;
  end if;
  select requested_units, status into req_units, req_status
    from hol_requests where business_id = bid and id = rid;
  if req_units is null or req_status = 'draft' then return null; end if;
  select coalesce(sum(units), 0) into day_sum
    from hol_request_days where business_id = bid and request_id = rid;
  if day_sum <> req_units then
    raise exception 'Request % total % does not match charged days %', rid, req_units, day_sum;
  end if;
  return null;
end $$;

drop trigger if exists trg_hol_total_req on hol_requests;
create constraint trigger trg_hol_total_req after insert or update on hol_requests
  deferrable initially deferred for each row execute function hol_check_request_total();

drop trigger if exists trg_hol_total_days on hol_request_days;
create constraint trigger trg_hol_total_days after insert or update on hol_request_days
  deferrable initially deferred for each row execute function hol_check_request_total();

-- Keep updated_at fresh
create or replace function hol_touch() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_hol_touch_biz on hol_businesses;
create trigger trg_hol_touch_biz before update on hol_businesses
  for each row execute function hol_touch();
drop trigger if exists trg_hol_touch_emp on hol_employees;
create trigger trg_hol_touch_emp before update on hol_employees
  for each row execute function hol_touch();
drop trigger if exists trg_hol_touch_req on hol_requests;
create trigger trg_hol_touch_req before update on hol_requests
  for each row execute function hol_touch();

-- ---------------------------------------------------------------------
-- 11. Balance helper: authoritative figure straight from the ledger
-- ---------------------------------------------------------------------
create or replace function hol_available(p_business uuid, p_employee uuid,
                                         p_type uuid, p_year uuid)
returns numeric language sql stable as $$
  select coalesce(sum(quantity), 0)
    from hol_ledger
   where business_id = p_business and employee_id = p_employee
     and leave_type_id = p_type and leave_year_id = p_year;
$$;

-- ---------------------------------------------------------------------
-- 12. Default data for a new business (called by cbs-hol when creating one)
-- ---------------------------------------------------------------------
create or replace function hol_seed_business(p_business uuid) returns void
language plpgsql as $$
declare y int := extract(year from current_date)::int;
begin
  insert into hol_leave_types (business_id, code, name, unit, balance_tracked, requires_approval, is_sickness) values
    (p_business,'annual','Annual leave','days',true,true,false),
    (p_business,'sick','Sickness absence','days',false,false,true),
    (p_business,'unpaid','Unpaid leave','days',false,true,false),
    (p_business,'compassionate','Compassionate leave','days',false,true,false),
    (p_business,'toil','Time off in lieu','hours',true,true,false),
    (p_business,'other','Other authorised absence','days',false,true,false)
  on conflict do nothing;

  insert into hol_leave_years (business_id, label, starts_on, ends_on)
    values (p_business, y::text, make_date(y,1,1), make_date(y,12,31))
  on conflict do nothing;

  insert into hol_work_schedules (business_id, name, week_pattern)
    values (p_business, 'Standard Mon-Fri',
      '{"mon":7.5,"tue":7.5,"wed":7.5,"thu":7.5,"fri":7.5,"sat":0,"sun":0}'::jsonb)
  on conflict do nothing;

  insert into hol_policies (business_id, name, version, status, effective_from, rules)
    values (p_business, 'Standard annual leave', 1, 'active', make_date(y,1,1),
      '{"leave_type":"annual","entitlement":28,"accrual":"upfront","carry_over_max":5,"carry_over_expiry":"03-31","bank_holidays_included":true}'::jsonb)
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------------
-- 13. Lock everything down: RLS on, no policies, no anon/authenticated grants
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables
            where schemaname = 'public' and tablename like 'hol\_%' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke execute on function hol_seed_business(uuid) from public, anon, authenticated;
revoke execute on function hol_available(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- =====================================================================
-- 14. Transaction functions (Step 3, Part 2)
-- Called only by the cbs-hol Edge Function with the service role.
-- Each function runs as one transaction, so a failure leaves nothing half-done.
-- =====================================================================

create or replace function hol_refresh_balance(p_business uuid, p_employee uuid, p_type uuid, p_year uuid)
returns void language plpgsql as $$
begin
  insert into hol_balances (business_id, employee_id, leave_type_id, leave_year_id, cached_available)
  values (p_business, p_employee, p_type, p_year, hol_available(p_business, p_employee, p_type, p_year))
  on conflict (business_id, employee_id, leave_type_id, leave_year_id)
  do update set cached_available = excluded.cached_available, updated_at = now();
end $$;

-- Ensures the balance row exists, locks it (serialises concurrent changes), returns the ledger balance.
create or replace function hol_lock_balance(p_business uuid, p_employee uuid, p_type uuid, p_year uuid)
returns numeric language plpgsql as $$
begin
  insert into hol_balances (business_id, employee_id, leave_type_id, leave_year_id)
  values (p_business, p_employee, p_type, p_year)
  on conflict do nothing;
  perform 1 from hol_balances
   where business_id = p_business and employee_id = p_employee
     and leave_type_id = p_type and leave_year_id = p_year
   for update;
  return hol_available(p_business, p_employee, p_type, p_year);
end $$;

-- Posts one ledger entry idempotently. Returns false if the idempotency key was already used.
create or replace function hol_post_entry(
  p_business uuid, p_employee uuid, p_type uuid, p_year uuid,
  p_entry_type text, p_quantity numeric, p_key text, p_by uuid, p_note text)
returns boolean language plpgsql as $$
declare inserted integer; eff date;
begin
  perform hol_lock_balance(p_business, p_employee, p_type, p_year);
  select starts_on into eff from hol_leave_years where business_id = p_business and id = p_year;
  if eff is null then raise exception 'NO_LEAVE_YEAR'; end if;
  insert into hol_ledger (business_id, employee_id, leave_type_id, leave_year_id, entry_type,
                          quantity, effective_date, idempotency_key, created_by, note)
  values (p_business, p_employee, p_type, p_year, p_entry_type, p_quantity, eff, p_key, p_by, p_note)
  on conflict (business_id, idempotency_key) do nothing;
  get diagnostics inserted = row_count;
  perform hol_refresh_balance(p_business, p_employee, p_type, p_year);
  return inserted > 0;
end $$;

-- Creates a request, its charged days, the approval step (or the booking, if no approval is needed),
-- the notification, outbox event and audit record, all in one transaction.
drop function if exists hol_submit_request(uuid, uuid, uuid, uuid, date, date, text, text, numeric, text, jsonb, jsonb, boolean, boolean, boolean, uuid);
create or replace function hol_submit_request(
  p_business uuid, p_employee uuid, p_type uuid, p_policy uuid,
  p_start date, p_end date, p_start_half text, p_end_half text,
  p_units numeric, p_comment text, p_snapshot jsonb, p_days jsonb,
  p_requires_approval boolean, p_tracked boolean, p_allow_negative boolean, p_approver uuid,
  p_replaces uuid default null)
returns jsonb language plpgsql as $$
declare
  y record; avail numeric; pend numeric; rid uuid; st text; who text; old_id uuid;
begin
  if p_requires_approval and p_approver is null then raise exception 'NO_APPROVER'; end if;

  -- Editing: withdraw the old pending (or sent-back) request in the same transaction, before the balance check,
  -- so it neither blocks the new dates nor counts against the balance.
  if p_replaces is not null then
    update hol_requests set status = 'cancelled', version = version + 1, decided_at = now()
     where business_id = p_business and id = p_replaces and employee_id = p_employee
       and status in ('draft', 'pending')
    returning id into old_id;
    if old_id is null then raise exception 'NOT_CANCELLABLE'; end if;
    update hol_approval_steps set status = 'skipped', decided_at = now()
     where business_id = p_business and request_id = old_id and status = 'pending';
  end if;

  -- Lock one balance row per leave year, in a fixed order so two requests cannot deadlock.
  if p_tracked then
    for y in
      select yid, sum(u) as units from (
        select (d->>'leave_year_id')::uuid as yid, (d->>'units')::numeric as u
          from jsonb_array_elements(p_days) d) x
      group by yid order by yid
    loop
      avail := hol_lock_balance(p_business, p_employee, p_type, y.yid);
      select coalesce(sum(rd.units), 0) into pend
        from hol_request_days rd
        join hol_requests r on r.business_id = rd.business_id and r.id = rd.request_id
       where rd.business_id = p_business and r.employee_id = p_employee
         and r.leave_type_id = p_type and rd.leave_year_id = y.yid and r.status = 'pending';
      if not p_allow_negative and (avail - pend) < y.units then
        raise exception 'INSUFFICIENT_BALANCE|%|%', round(avail - pend, 2), round(y.units, 2);
      end if;
    end loop;
  end if;

  st := case when p_requires_approval then 'pending' else 'approved' end;

  insert into hol_requests (business_id, employee_id, leave_type_id, policy_id, start_date, end_date,
                            start_half, end_half, requested_units, status, comment, policy_snapshot,
                            submitted_at, decided_at)
  values (p_business, p_employee, p_type, p_policy, p_start, p_end,
          p_start_half, p_end_half, p_units, st, p_comment, coalesce(p_snapshot, '{}'::jsonb),
          now(), case when p_requires_approval then null else now() end)
  returning id into rid;

  insert into hol_request_days (business_id, request_id, leave_year_id, leave_date, units)
  select p_business, rid, (d->>'leave_year_id')::uuid, (d->>'date')::date, (d->>'units')::numeric
    from jsonb_array_elements(p_days) d;

  select full_name into who from hol_employees where business_id = p_business and id = p_employee;

  if p_requires_approval then
    insert into hol_approval_steps (business_id, request_id, step_number, approver_id)
    values (p_business, rid, 1, p_approver);
    insert into hol_notifications (business_id, employee_id, title, body, request_id)
    values (p_business, p_approver, 'Leave request to review',
            format('%s requested leave from %s to %s', who, p_start, p_end), rid);
  elsif p_tracked then
    insert into hol_ledger (business_id, employee_id, leave_type_id, leave_year_id, request_id,
                            entry_type, quantity, effective_date, idempotency_key, created_by)
    select p_business, p_employee, p_type, yid, rid, 'booking', -sum(u), min(dt),
           'booking:' || rid || ':' || yid, p_employee
      from (select (d->>'leave_year_id')::uuid as yid, (d->>'date')::date as dt, (d->>'units')::numeric as u
              from jsonb_array_elements(p_days) d) x
     group by yid;
    for y in select distinct (d->>'leave_year_id')::uuid as yid from jsonb_array_elements(p_days) d loop
      perform hol_refresh_balance(p_business, p_employee, p_type, y.yid);
    end loop;
  end if;

  insert into hol_outbox (business_id, event_type, aggregate_id, payload)
  values (p_business, 'leave.request.submitted', rid,
          jsonb_build_object('employee_id', p_employee, 'status', st, 'start', p_start, 'end', p_end, 'units', p_units));
  insert into hol_audit_log (business_id, actor_id, action, entity_type, entity_id, changes)
  values (p_business, p_employee, 'leave.request.submitted', 'request', rid,
          jsonb_build_object('start', p_start, 'end', p_end, 'units', p_units, 'status', st, 'replaces', p_replaces));

  return jsonb_build_object('request_id', rid, 'status', st);
end $$;

-- Employee cancels their own request while it is still pending.
create or replace function hol_cancel_request(p_business uuid, p_request uuid, p_actor uuid)
returns jsonb language plpgsql as $$
declare rid uuid;
begin
  update hol_requests
     set status = 'cancelled', version = version + 1, decided_at = now()
   where business_id = p_business and id = p_request and employee_id = p_actor
     and status in ('draft', 'pending')
  returning id into rid;
  if rid is null then raise exception 'NOT_CANCELLABLE'; end if;

  update hol_approval_steps set status = 'skipped', decided_at = now()
   where business_id = p_business and request_id = rid and status = 'pending';

  insert into hol_outbox (business_id, event_type, aggregate_id, payload)
  values (p_business, 'leave.request.cancelled', rid, jsonb_build_object('employee_id', p_actor));
  insert into hol_audit_log (business_id, actor_id, action, entity_type, entity_id)
  values (p_business, p_actor, 'leave.request.cancelled', 'request', rid);

  return jsonb_build_object('request_id', rid, 'status', 'cancelled');
end $$;

revoke execute on function hol_refresh_balance(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function hol_lock_balance(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function hol_post_entry(uuid, uuid, uuid, uuid, text, numeric, text, uuid, text) from public, anon, authenticated;
revoke execute on function hol_submit_request(uuid, uuid, uuid, uuid, date, date, text, text, numeric, text, jsonb, jsonb, boolean, boolean, boolean, uuid, uuid) from public, anon, authenticated;
revoke execute on function hol_cancel_request(uuid, uuid, uuid) from public, anon, authenticated;

-- =====================================================================
-- 15. Approval functions (Step 4, Part 1)
-- =====================================================================

-- Releases whatever is still booked for a request back to the balance (used when leave is cancelled).
create or replace function hol_release_request(p_business uuid, p_request uuid, p_employee uuid, p_type uuid, p_by uuid)
returns void language plpgsql as $$
declare y record;
begin
  for y in
    select leave_year_id as yid, sum(quantity) as net
      from hol_ledger
     where business_id = p_business and request_id = p_request and entry_type in ('booking', 'release')
     group by leave_year_id
    having sum(quantity) < 0
     order by leave_year_id
  loop
    perform hol_lock_balance(p_business, p_employee, p_type, y.yid);
    insert into hol_ledger (business_id, employee_id, leave_type_id, leave_year_id, request_id,
                            entry_type, quantity, effective_date, idempotency_key, created_by)
    values (p_business, p_employee, p_type, y.yid, p_request, 'release', -y.net, current_date,
            'release:' || p_request || ':' || y.yid, p_by)
    on conflict (business_id, idempotency_key) do nothing;
    perform hol_refresh_balance(p_business, p_employee, p_type, y.yid);
  end loop;
end $$;

-- Approve, reject or request changes on a pending request or a pending cancellation.
-- Locks the request row, checks the version the approver was looking at, re-checks the balance,
-- and books or releases the ledger in the same transaction.
create or replace function hol_decide_request(
  p_business uuid, p_request uuid, p_actor uuid, p_decision text, p_comment text,
  p_expected_version integer, p_override boolean)
returns jsonb language plpgsql as $$
declare
  req hol_requests%rowtype;
  stp hol_approval_steps%rowtype;
  tracked boolean; allow_neg boolean; is_cancel boolean;
  y record; avail numeric; emp_status text;
  new_status text; ntitle text; step_status text; who text;
begin
  if p_decision not in ('approved', 'rejected', 'changes_requested') then raise exception 'INVALID_DECISION'; end if;

  select * into req from hol_requests where business_id = p_business and id = p_request for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if req.version <> p_expected_version or req.status not in ('pending', 'cancellation_pending') then
    raise exception 'STALE';
  end if;
  if req.employee_id = p_actor then raise exception 'SELF_APPROVAL'; end if;

  select * into stp from hol_approval_steps
   where business_id = p_business and request_id = p_request and status = 'pending'
   order by step_number desc limit 1;
  if not found then raise exception 'STALE'; end if;

  if not (p_override
          or stp.approver_id = p_actor
          or exists (select 1 from hol_delegations d
                      where d.business_id = p_business and d.from_id = stp.approver_id and d.to_id = p_actor
                        and current_date between d.starts_on and d.ends_on)) then
    raise exception 'FORBIDDEN';
  end if;

  is_cancel := (req.status = 'cancellation_pending');
  if p_decision = 'changes_requested' and is_cancel then raise exception 'INVALID_DECISION'; end if;

  select balance_tracked into tracked from hol_leave_types
   where business_id = p_business and id = req.leave_type_id;
  allow_neg := coalesce((req.policy_snapshot->'rules'->>'allow_negative')::boolean, false);

  if p_decision = 'approved' and not is_cancel then
    select status into emp_status from hol_employees where business_id = p_business and id = req.employee_id;
    if emp_status is distinct from 'active' then raise exception 'EMPLOYEE_INACTIVE'; end if;
    if tracked then
      for y in
        select leave_year_id as yid, sum(units) as units, min(leave_date) as first_day
          from hol_request_days where business_id = p_business and request_id = p_request
         group by leave_year_id order by leave_year_id
      loop
        avail := hol_lock_balance(p_business, req.employee_id, req.leave_type_id, y.yid);
        if not allow_neg and avail < y.units then
          raise exception 'INSUFFICIENT_BALANCE|%|%', round(avail, 2), round(y.units, 2);
        end if;
        insert into hol_ledger (business_id, employee_id, leave_type_id, leave_year_id, request_id,
                                entry_type, quantity, effective_date, idempotency_key, created_by)
        values (p_business, req.employee_id, req.leave_type_id, y.yid, p_request, 'booking',
                -y.units, y.first_day, 'booking:' || p_request || ':' || y.yid, p_actor)
        on conflict (business_id, idempotency_key) do nothing;
        perform hol_refresh_balance(p_business, req.employee_id, req.leave_type_id, y.yid);
      end loop;
    end if;
    new_status := 'approved'; ntitle := 'Leave approved'; step_status := 'approved';
  elsif p_decision = 'approved' and is_cancel then
    perform hol_release_request(p_business, p_request, req.employee_id, req.leave_type_id, p_actor);
    new_status := 'cancelled'; ntitle := 'Cancellation approved'; step_status := 'approved';
  elsif p_decision = 'rejected' and is_cancel then
    new_status := 'approved'; ntitle := 'Cancellation declined'; step_status := 'rejected';
  elsif p_decision = 'rejected' then
    new_status := 'rejected'; ntitle := 'Leave rejected'; step_status := 'rejected';
  else
    new_status := 'draft'; ntitle := 'Changes requested'; step_status := 'skipped';
  end if;

  update hol_requests
     set status = new_status, version = version + 1, decided_at = now()
   where business_id = p_business and id = p_request;
  update hol_approval_steps set status = step_status, decided_at = now()
   where business_id = p_business and id = stp.id;
  insert into hol_approval_decisions (business_id, step_id, actor_id, decision, comment)
  values (p_business, stp.id, p_actor, p_decision, p_comment);

  select full_name into who from hol_employees where business_id = p_business and id = p_actor;
  insert into hol_notifications (business_id, employee_id, title, body, request_id)
  values (p_business, req.employee_id, ntitle,
          format('%s: %s to %s%s', who, req.start_date, req.end_date,
                 case when coalesce(p_comment, '') <> '' then ' - ' || p_comment else '' end), p_request);
  insert into hol_outbox (business_id, event_type, aggregate_id, payload)
  values (p_business, 'leave.request.decided', p_request,
          jsonb_build_object('employee_id', req.employee_id, 'decision', p_decision, 'status', new_status, 'cancellation', is_cancel));
  insert into hol_audit_log (business_id, actor_id, action, entity_type, entity_id, changes)
  values (p_business, p_actor, 'leave.request.' || p_decision, 'request', p_request,
          jsonb_build_object('status', new_status, 'comment', p_comment, 'cancellation', is_cancel, 'override', p_override));

  return jsonb_build_object('request_id', p_request, 'status', new_status, 'version', req.version + 1);
end $$;

-- Employee asks to cancel approved leave. With an approver it becomes cancellation_pending;
-- without one (leave types that need no approval) it is cancelled and released immediately.
create or replace function hol_cancel_approved(
  p_business uuid, p_request uuid, p_actor uuid, p_approver uuid, p_reason text)
returns jsonb language plpgsql as $$
declare req hol_requests%rowtype; who text; n integer; st text;
begin
  select * into req from hol_requests
   where business_id = p_business and id = p_request and employee_id = p_actor for update;
  if not found or req.status <> 'approved' or req.end_date < current_date then
    raise exception 'NOT_CANCELLABLE';
  end if;

  if p_approver is null then
    perform hol_release_request(p_business, p_request, req.employee_id, req.leave_type_id, p_actor);
    update hol_requests set status = 'cancelled', version = version + 1, decided_at = now()
     where business_id = p_business and id = p_request;
    st := 'cancelled';
  else
    select coalesce(max(step_number), 0) + 1 into n from hol_approval_steps
     where business_id = p_business and request_id = p_request;
    update hol_requests set status = 'cancellation_pending', version = version + 1
     where business_id = p_business and id = p_request;
    insert into hol_approval_steps (business_id, request_id, step_number, approver_id)
    values (p_business, p_request, n, p_approver);
    select full_name into who from hol_employees where business_id = p_business and id = p_actor;
    insert into hol_notifications (business_id, employee_id, title, body, request_id)
    values (p_business, p_approver, 'Cancellation to review',
            format('%s asked to cancel leave from %s to %s%s', who, req.start_date, req.end_date,
                   case when coalesce(p_reason, '') <> '' then ' - ' || p_reason else '' end), p_request);
    st := 'cancellation_pending';
  end if;

  insert into hol_outbox (business_id, event_type, aggregate_id, payload)
  values (p_business, 'leave.request.cancellation', p_request, jsonb_build_object('employee_id', p_actor, 'status', st));
  insert into hol_audit_log (business_id, actor_id, action, entity_type, entity_id, changes)
  values (p_business, p_actor, 'leave.request.cancellation_requested', 'request', p_request,
          jsonb_build_object('status', st, 'reason', p_reason));

  return jsonb_build_object('request_id', p_request, 'status', st);
end $$;

revoke execute on function hol_release_request(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function hol_decide_request(uuid, uuid, uuid, text, text, integer, boolean) from public, anon, authenticated;
revoke execute on function hol_cancel_approved(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

-- =====================================================================
-- 16. Business setup functions (Step 5)
-- =====================================================================

-- Gives employees a policy from a date. Ends any earlier assignment the day before, so periods never overlap.
create or replace function hol_assign_policy(p_business uuid, p_policy uuid, p_employees uuid[], p_from date)
returns integer language plpgsql as $$
declare e uuid; n integer := 0;
begin
  perform 1 from hol_policies where business_id = p_business and id = p_policy;
  if not found then raise exception 'NOT_FOUND'; end if;
  foreach e in array p_employees loop
    if exists (select 1 from hol_policy_assignments
                where business_id = p_business and employee_id = e and effective_from > p_from) then
      raise exception 'ASSIGNMENT_CONFLICT|%', e;
    end if;
    update hol_policy_assignments set policy_id = p_policy
     where business_id = p_business and employee_id = e and effective_from = p_from;
    if not found then
      update hol_policy_assignments set effective_to = p_from - 1
       where business_id = p_business and employee_id = e and effective_from < p_from
         and (effective_to is null or effective_to >= p_from);
      insert into hol_policy_assignments (business_id, employee_id, policy_id, effective_from)
      values (p_business, e, p_policy, p_from);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function hol_assign_schedule(p_business uuid, p_schedule uuid, p_employees uuid[], p_from date)
returns integer language plpgsql as $$
declare e uuid; n integer := 0;
begin
  perform 1 from hol_work_schedules where business_id = p_business and id = p_schedule;
  if not found then raise exception 'NOT_FOUND'; end if;
  foreach e in array p_employees loop
    if exists (select 1 from hol_schedule_assignments
                where business_id = p_business and employee_id = e and effective_from > p_from) then
      raise exception 'ASSIGNMENT_CONFLICT|%', e;
    end if;
    update hol_schedule_assignments set schedule_id = p_schedule
     where business_id = p_business and employee_id = e and effective_from = p_from;
    if not found then
      update hol_schedule_assignments set effective_to = p_from - 1
       where business_id = p_business and employee_id = e and effective_from < p_from
         and (effective_to is null or effective_to >= p_from);
      insert into hol_schedule_assignments (business_id, employee_id, schedule_id, effective_from)
      values (p_business, e, p_schedule, p_from);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Marks an employee as having left. Withdraws their pending requests and cancels (and releases)
-- approved leave that starts after their last day. Leave already under way is left alone.
create or replace function hol_terminate_employee(p_business uuid, p_employee uuid, p_end date, p_actor uuid)
returns jsonb language plpgsql as $$
declare r record; withdrawn integer := 0; cancelled integer := 0;
begin
  update hol_employees set status = 'terminated', employment_end = p_end, pin_hash = null
   where business_id = p_business and id = p_employee;
  if not found then raise exception 'NOT_FOUND'; end if;

  for r in select id from hol_requests
            where business_id = p_business and employee_id = p_employee and status in ('pending', 'draft') loop
    update hol_requests set status = 'cancelled', version = version + 1, decided_at = now()
     where business_id = p_business and id = r.id;
    update hol_approval_steps set status = 'skipped', decided_at = now()
     where business_id = p_business and request_id = r.id and status = 'pending';
    withdrawn := withdrawn + 1;
  end loop;

  for r in select id, leave_type_id from hol_requests
            where business_id = p_business and employee_id = p_employee
              and status in ('approved', 'cancellation_pending') and start_date > p_end loop
    perform hol_release_request(p_business, r.id, p_employee, r.leave_type_id, p_actor);
    update hol_requests set status = 'cancelled', version = version + 1, decided_at = now()
     where business_id = p_business and id = r.id;
    update hol_approval_steps set status = 'skipped', decided_at = now()
     where business_id = p_business and request_id = r.id and status = 'pending';
    cancelled := cancelled + 1;
  end loop;

  delete from hol_sessions where business_id = p_business and employee_id = p_employee;
  insert into hol_audit_log (business_id, actor_id, action, entity_type, entity_id, changes)
  values (p_business, p_actor, 'employee.terminated', 'employee', p_employee,
          jsonb_build_object('employment_end', p_end, 'withdrawn', withdrawn, 'cancelled', cancelled));
  return jsonb_build_object('withdrawn', withdrawn, 'cancelled', cancelled);
end $$;

revoke execute on function hol_assign_policy(uuid, uuid, uuid[], date) from public, anon, authenticated;
revoke execute on function hol_assign_schedule(uuid, uuid, uuid[], date) from public, anon, authenticated;
revoke execute on function hol_terminate_employee(uuid, uuid, date, uuid) from public, anon, authenticated;

-- =====================================================================
-- 17. Team limits (Step 6)
-- =====================================================================
alter table hol_departments add column if not exists max_concurrent_absent integer
  check (max_concurrent_absent is null or max_concurrent_absent >= 1);

-- =====================================================================
-- 18. Reporting (Step 7)
-- =====================================================================
-- One row per employee and leave type for a leave year, summed straight from the ledger.
create or replace function hol_balance_report(p_business uuid, p_year uuid)
returns table (emp_id uuid, type_id uuid, entitlement numeric, booked numeric, taken numeric,
               expired numeric, pending numeric, available numeric)
language sql stable as $$
  with l as (
    select g.employee_id as e, g.leave_type_id as t,
           sum(case when g.entry_type in ('allocation', 'accrual', 'carry_over', 'adjustment') then g.quantity else 0 end) as ent,
           -sum(case when g.entry_type in ('booking', 'release') then g.quantity else 0 end) as bk,
           -sum(case when g.entry_type = 'taken' then g.quantity else 0 end) as tk,
           -sum(case when g.entry_type = 'expiry' then g.quantity else 0 end) as ex,
           sum(g.quantity) as av
      from hol_ledger g
     where g.business_id = p_business and g.leave_year_id = p_year
     group by g.employee_id, g.leave_type_id),
  p as (
    select r.employee_id as e, r.leave_type_id as t, sum(d.units) as pd
      from hol_requests r
      join hol_request_days d on d.business_id = r.business_id and d.request_id = r.id
     where r.business_id = p_business and r.status = 'pending' and d.leave_year_id = p_year
     group by r.employee_id, r.leave_type_id)
  select coalesce(l.e, p.e), coalesce(l.t, p.t),
         coalesce(l.ent, 0), coalesce(l.bk, 0), coalesce(l.tk, 0), coalesce(l.ex, 0),
         coalesce(p.pd, 0), coalesce(l.av, 0)
    from l full join p on p.e = l.e and p.t = l.t
   order by 1, 2;
$$;
revoke execute on function hol_balance_report(uuid, uuid) from public, anon, authenticated;

-- =====================================================================
-- 19. Automation (Step 8): taken leave, carry-over and expiry, sickness, email, daily jobs
-- =====================================================================
alter table hol_notifications add column if not exists emailed_at timestamptz;
create index if not exists idx_hol_notif_unsent on hol_notifications (created_at) where emailed_at is null;

-- Sickness records may not overlap for one person (an open record runs to infinity).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'hol_absence_no_overlap') then
    alter table hol_absence_records add constraint hol_absence_no_overlap exclude using gist (
      business_id with =, employee_id with =,
      daterange(starts_on, coalesce(ends_on, 'infinity'::date), '[]') with &&);
  end if;
end $$;

-- Approved leave whose last day has passed becomes "completed" (taken): the booking is converted to taken.
create or replace function hol_complete_due(p_business uuid default null, p_today date default null)
returns integer language plpgsql as $$
declare r record; y record; n integer := 0;
begin
  for r in
    select q.id, q.business_id, q.employee_id, q.leave_type_id
      from hol_requests q join hol_businesses b on b.id = q.business_id
     where q.status = 'approved' and b.status = 'active'
       and (p_business is null or q.business_id = p_business)
       and q.end_date < coalesce(p_today, (now() at time zone b.timezone)::date)
     order by q.business_id, q.end_date, q.id
       for update of q skip locked
  loop
    for y in
      select leave_year_id as yid, sum(quantity) as net from hol_ledger
       where business_id = r.business_id and request_id = r.id and entry_type in ('booking', 'release')
       group by leave_year_id having sum(quantity) < 0 order by leave_year_id
    loop
      perform hol_lock_balance(r.business_id, r.employee_id, r.leave_type_id, y.yid);
      insert into hol_ledger (business_id, employee_id, leave_type_id, leave_year_id, request_id, entry_type, quantity, effective_date, idempotency_key)
      values (r.business_id, r.employee_id, r.leave_type_id, y.yid, r.id, 'release', -y.net, current_date, 'taken-release:' || r.id || ':' || y.yid),
             (r.business_id, r.employee_id, r.leave_type_id, y.yid, r.id, 'taken', y.net, current_date, 'taken:' || r.id || ':' || y.yid)
      on conflict (business_id, idempotency_key) do nothing;
      perform hol_refresh_balance(r.business_id, r.employee_id, r.leave_type_id, y.yid);
    end loop;
    update hol_requests set status = 'completed', version = version + 1 where business_id = r.business_id and id = r.id;
    insert into hol_audit_log (business_id, actor_label, action, entity_type, entity_id)
    values (r.business_id, 'system', 'leave.request.completed', 'request', r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Carries unused leave from one leave year to the next, up to each person's policy limit (rounded down to the half day).
create or replace function hol_carry_over(p_business uuid, p_from uuid, p_to uuid, p_actor uuid)
returns jsonb language plpgsql as $$
declare
  r record; to_start date; pol record; carry numeric; code text; n integer := 0; total numeric := 0; no_policy integer := 0;
begin
  select starts_on into to_start from hol_leave_years where business_id = p_business and id = p_to;
  if to_start is null then raise exception 'NOT_FOUND'; end if;
  perform 1 from hol_leave_years where business_id = p_business and id = p_from;
  if not found then raise exception 'NOT_FOUND'; end if;
  for r in
    select g.employee_id as e, g.leave_type_id as t, sum(g.quantity) as av, lt.code as lcode
      from hol_ledger g join hol_leave_types lt on lt.business_id = g.business_id and lt.id = g.leave_type_id
      join hol_employees em on em.business_id = g.business_id and em.id = g.employee_id and em.status = 'active'
     where g.business_id = p_business and g.leave_year_id = p_from
     group by g.employee_id, g.leave_type_id, lt.code
    having sum(g.quantity) > 0
  loop
    select p.rules into pol from hol_policy_assignments a join hol_policies p on p.business_id = a.business_id and p.id = a.policy_id
     where a.business_id = p_business and a.employee_id = r.e and a.effective_from <= to_start
       and (a.effective_to is null or a.effective_to >= to_start)
     order by a.effective_from desc limit 1;
    if not found then no_policy := no_policy + 1; continue; end if;
    code := coalesce(pol.rules->>'leave_type', 'annual');
    if code <> r.lcode then continue; end if;
    carry := floor(least(r.av, coalesce((pol.rules->>'carry_over_max')::numeric, 0)) * 2) / 2;
    if carry <= 0 then continue; end if;
    if hol_post_entry(p_business, r.e, r.t, p_to, 'carry_over', carry, 'carry:' || r.e || ':' || p_from || ':' || p_to, p_actor, 'Carried over') then
      n := n + 1; total := total + carry;
    end if;
  end loop;
  insert into hol_audit_log (business_id, actor_id, action, entity_type, entity_id, changes)
  values (p_business, p_actor, 'balance.carried_over', 'leave_year', p_to, jsonb_build_object('people', n, 'days', total));
  return jsonb_build_object('carried', n, 'days', total, 'no_policy', no_policy);
end $$;

-- Once a person's carry-over expiry date has passed, unused carried days are removed.
-- Days taken up to the expiry date are counted against the carried days first.
create or replace function hol_expire_carry(p_business uuid default null, p_today date default null)
returns integer language plpgsql as $$
declare
  r record; pol record; exp date; used numeric; unused numeric; mm integer; dd integer; n integer := 0; today_local date;
begin
  for r in
    select g.business_id as b, g.employee_id as e, g.leave_type_id as t, g.leave_year_id as y,
           sum(g.quantity) as carried, ly.starts_on as ys, bz.timezone as tz
      from hol_ledger g
      join hol_leave_years ly on ly.business_id = g.business_id and ly.id = g.leave_year_id
      join hol_businesses bz on bz.id = g.business_id and bz.status = 'active'
     where g.entry_type = 'carry_over' and (p_business is null or g.business_id = p_business)
     group by g.business_id, g.employee_id, g.leave_type_id, g.leave_year_id, ly.starts_on, bz.timezone
    having sum(g.quantity) > 0
  loop
    if exists (select 1 from hol_ledger x where x.business_id = r.b and x.idempotency_key = 'expiry:' || r.e || ':' || r.y || ':' || r.t) then continue; end if;
    select p.rules into pol from hol_policy_assignments a join hol_policies p on p.business_id = a.business_id and p.id = a.policy_id
     where a.business_id = r.b and a.employee_id = r.e and a.effective_from <= r.ys and (a.effective_to is null or a.effective_to >= r.ys)
     order by a.effective_from desc limit 1;
    if not found then continue; end if;
    mm := coalesce(substr(pol.rules->>'carry_over_expiry', 1, 2), '03')::integer;
    dd := coalesce(substr(pol.rules->>'carry_over_expiry', 4, 2), '31')::integer;
    exp := least(make_date(extract(year from r.ys)::integer, mm, 1) + (dd - 1),
                 (date_trunc('month', make_date(extract(year from r.ys)::integer, mm, 1)) + interval '1 month - 1 day')::date);
    if exp < r.ys then exp := exp + interval '1 year'; end if;
    today_local := coalesce(p_today, (now() at time zone r.tz)::date);
    if today_local <= exp then continue; end if;

    select coalesce(sum(d.units), 0) into used
      from hol_request_days d join hol_requests q on q.business_id = d.business_id and q.id = d.request_id
     where d.business_id = r.b and q.employee_id = r.e and q.leave_type_id = r.t and d.leave_year_id = r.y
       and d.leave_date <= exp and q.status in ('approved', 'completed', 'cancellation_pending');
    unused := greatest(0, r.carried - used);
    if unused > 0 then
      perform hol_lock_balance(r.b, r.e, r.t, r.y);
      insert into hol_ledger (business_id, employee_id, leave_type_id, leave_year_id, entry_type, quantity, effective_date, idempotency_key, note)
      values (r.b, r.e, r.t, r.y, 'expiry', -unused, exp, 'expiry:' || r.e || ':' || r.y || ':' || r.t, 'Carried leave expired')
      on conflict (business_id, idempotency_key) do nothing;
      perform hol_refresh_balance(r.b, r.e, r.t, r.y);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

revoke execute on function hol_complete_due(uuid, date) from public, anon, authenticated;
revoke execute on function hol_carry_over(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function hol_expire_carry(uuid, date) from public, anon, authenticated;

-- =====================================================================
-- 20. Hardening (Step 9)
-- =====================================================================
create table if not exists hol_throttle (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         integer not null default 0
);
alter table hol_throttle enable row level security;
revoke all on hol_throttle from anon, authenticated;

-- True when this key has reached its limit inside the current window.
create or replace function hol_throttle_blocked(p_key text, p_limit integer, p_secs integer)
returns boolean language sql stable as $$
  select coalesce((select hits >= p_limit and window_start >= now() - make_interval(secs => p_secs)
                     from hol_throttle where key = p_key), false)
$$;

-- Records one failure, starting a new window when the old one has run out.
create or replace function hol_throttle_fail(p_key text, p_secs integer)
returns void language sql as $$
  insert into hol_throttle (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when hol_throttle.window_start < now() - make_interval(secs => p_secs) then 1 else hol_throttle.hits + 1 end,
    window_start = case when hol_throttle.window_start < now() - make_interval(secs => p_secs) then now() else hol_throttle.window_start end
$$;

alter table hol_employees add column if not exists anonymised_at timestamptz;

-- Removes personal details of someone who has left, keeping the leave records that accounts depend on.
-- Names are also scrubbed from other people's notification text. The append-only ledger and audit log are not touched.
create or replace function hol_anonymise_employee(p_business uuid, p_employee uuid, p_actor uuid)
returns jsonb language plpgsql as $$
declare e record; scrubbed integer; gone integer;
begin
  select * into e from hol_employees where business_id = p_business and id = p_employee for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if e.status <> 'terminated' then raise exception 'NOT_LEFT'; end if;
  if e.anonymised_at is not null then raise exception 'ALREADY_DONE'; end if;

  update hol_employees set full_name = 'Former employee ' || employee_number, email = null, pin_hash = null,
         pin_attempts = 0, locked_until = null, anonymised_at = now()
   where business_id = p_business and id = p_employee;
  update hol_requests set comment = null where business_id = p_business and employee_id = p_employee;
  update hol_absence_records set details = null, reason_code = null where business_id = p_business and employee_id = p_employee;
  delete from hol_notifications where business_id = p_business and employee_id = p_employee;
  get diagnostics gone = row_count;
  update hol_notifications set body = replace(body, e.full_name, 'a former employee')
   where business_id = p_business and body like '%' || e.full_name || '%';
  get diagnostics scrubbed = row_count;
  delete from hol_sessions where business_id = p_business and employee_id = p_employee;
  insert into hol_audit_log (business_id, actor_id, actor_label, action, entity_type, entity_id, changes)
  values (p_business, p_actor, case when p_actor is null then 'system' end, 'employee.anonymised', 'employee', p_employee,
          jsonb_build_object('notifications_deleted', gone, 'notifications_scrubbed', scrubbed));
  return jsonb_build_object('notifications_deleted', gone, 'notifications_scrubbed', scrubbed);
end $$;

-- Retention: when a business has set settings.retention_years, people who left longer ago than that are anonymised.
create or replace function hol_anonymise_expired(p_today date default null)
returns integer language plpgsql as $$
declare r record; n integer := 0;
begin
  for r in
    select em.business_id, em.id
      from hol_employees em join hol_businesses b on b.id = em.business_id
     where em.status = 'terminated' and em.anonymised_at is null and em.employment_end is not null
       and coalesce((b.settings->>'retention_years')::numeric, 0) > 0
       and em.employment_end < coalesce(p_today, current_date) - ((b.settings->>'retention_years')::numeric * 365)::integer
  loop
    perform hol_anonymise_employee(r.business_id, r.id, null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Cached balances must always equal the ledger. Returns any that do not.
create or replace function hol_reconcile_balances(p_business uuid default null)
returns table (business_id uuid, employee_id uuid, leave_type_id uuid, leave_year_id uuid, cached numeric, ledger numeric)
language sql stable as $$
  select b.business_id, b.employee_id, b.leave_type_id, b.leave_year_id, b.cached_available,
         hol_available(b.business_id, b.employee_id, b.leave_type_id, b.leave_year_id)
    from hol_balances b
   where (p_business is null or b.business_id = p_business)
     and b.cached_available <> hol_available(b.business_id, b.employee_id, b.leave_type_id, b.leave_year_id)
$$;

-- Everything that should run once a day.
create or replace function hol_run_daily_jobs(p_today date default null)
returns jsonb language plpgsql as $$
declare completed integer; expired integer; sessions integer;
begin
  completed := hol_complete_due(null, p_today);
  expired := hol_expire_carry(null, p_today);
  delete from hol_sessions where expires_at < now();
  get diagnostics sessions = row_count;
  delete from hol_throttle where window_start < now() - interval '1 day';
  return jsonb_build_object('completed', completed, 'expired', expired, 'sessions_removed', sessions,
                            'anonymised', hol_anonymise_expired(p_today));
end $$;


revoke execute on function hol_throttle_blocked(text, integer, integer) from public, anon, authenticated;
revoke execute on function hol_throttle_fail(text, integer) from public, anon, authenticated;
revoke execute on function hol_anonymise_employee(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function hol_anonymise_expired(date) from public, anon, authenticated;
revoke execute on function hol_reconcile_balances(uuid) from public, anon, authenticated;
revoke execute on function hol_run_daily_jobs(date) from public, anon, authenticated;
