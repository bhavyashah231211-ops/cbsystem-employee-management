-- Taken leave, carry-over and expiry (Step 8). Run on an EMPTY test database after schema.sql. Expected results are in the section comments.
\set QUIET on
with b as (insert into hol_businesses(slug,name,staff_key_hash,owner_pin_hash) values ('t','Test','x','x') returning id) select hol_seed_business(id) from b \gset
insert into hol_leave_years(business_id,label,starts_on,ends_on) select id,'2027','2027-01-01','2027-12-31' from hol_businesses;
update hol_policies set rules = rules || '{"carry_over_max":5,"carry_over_expiry":"03-31"}'::jsonb;
insert into hol_employees(business_id,employee_number,full_name,role,employment_start) select id,n,n,r,'2020-01-01' from hol_businesses, (values ('M1','manager'),('E1','employee'),('E2','employee'),('E3','employee')) v(n,r);
insert into hol_policy_assignments(business_id,employee_id,policy_id,effective_from) select e.business_id,e.id,(select id from hol_policies limit 1),'2020-01-01' from hol_employees e where e.employee_number in ('E1','E2','E3');
create function pg_temp.biz() returns uuid language sql as $$ select id from hol_businesses where slug='t' $$;
create function pg_temp.eid(n text) returns uuid language sql as $$ select id from hol_employees where employee_number=n $$;
create function pg_temp.typ() returns uuid language sql as $$ select id from hol_leave_types where code='annual' and business_id=pg_temp.biz() $$;
create function pg_temp.yr(l text) returns uuid language sql as $$ select id from hol_leave_years where label=l $$;
create function pg_temp.av(n text, l text) returns numeric language sql as $$ select hol_available(pg_temp.biz(),pg_temp.eid(n),pg_temp.typ(),pg_temp.yr(l)) $$;
create function pg_temp.sub(n text, d1 date, d2 date, l text) returns uuid language sql as $$
  select (hol_submit_request(pg_temp.biz(), pg_temp.eid(n), pg_temp.typ(), null, d1, d2, null, null, (d2-d1+1)::numeric, null, '{"rules":{}}'::jsonb,
   (select jsonb_agg(jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'units',1,'leave_year_id',pg_temp.yr(l))) from generate_series(d1,d2,'1 day') d),
   true,true,false,pg_temp.eid('M1'))->>'request_id')::uuid $$;
create function pg_temp.ok(rid uuid) returns text language sql as $$ select hol_decide_request(pg_temp.biz(), rid, pg_temp.eid('M1'), 'approved', 'c', 1, false)->>'status' $$;
create function pg_temp.alloc(n text, l text, q numeric) returns boolean language sql as $$ select hol_post_entry(pg_temp.biz(),pg_temp.eid(n),pg_temp.typ(),pg_temp.yr(l),'allocation',q,'a:'||n||':'||l,null,null) $$;
select pg_temp.alloc('E1','2026',28), pg_temp.alloc('E2','2026',3.5), pg_temp.alloc('E3','2026',3.7) \gset

\echo === A. approved leave becomes taken after its last day
select pg_temp.sub('E1','2026-12-01','2026-12-03','2026') as r1 \gset
select pg_temp.ok(:'r1'::uuid) as approved;
select pg_temp.av('E1','2026') as available_25;
\echo -- before the last day nothing happens:
select hol_complete_due(null,'2026-12-03') as completed_none;
select hol_complete_due(null,'2026-12-04') as completed_one;
select status from hol_requests where id=:'r1';
select entry_type, quantity from hol_ledger where request_id=:'r1' order by entry_type;
select pg_temp.av('E1','2026') as available_still_25;
select booked, taken, available from hol_balance_report(pg_temp.biz(), pg_temp.yr('2026')) where emp_id=pg_temp.eid('E1');
select hol_complete_due(null,'2026-12-31') as completed_again_zero;
\echo -- a completed request cannot be cancelled:
select hol_cancel_approved(pg_temp.biz(), :'r1', pg_temp.eid('E1'), pg_temp.eid('M1'), null);

\echo === B. carry over (max 5, half-day steps)
select hol_carry_over(pg_temp.biz(), pg_temp.yr('2026'), pg_temp.yr('2027'), null);
select pg_temp.av('E1','2027') as e1_carried_5, pg_temp.av('E2','2027') as e2_carried_3_5, pg_temp.av('E3','2027') as e3_carried_3_5;
select hol_carry_over(pg_temp.biz(), pg_temp.yr('2026'), pg_temp.yr('2027'), null)->>'carried' as repeat_carries_zero;

\echo === C. expiry
select pg_temp.alloc('E1','2027',28), pg_temp.alloc('E2','2027',28), pg_temp.alloc('E3','2027',28) \gset
select pg_temp.sub('E1','2027-01-11','2027-01-12','2027') as e1r \gset
select pg_temp.ok(:'e1r'::uuid);
select pg_temp.sub('E3','2027-01-18','2027-01-22','2027') as e3r \gset
select pg_temp.ok(:'e3r'::uuid);
select hol_expire_carry(null,'2027-03-31') as expired_on_the_last_day_zero;
select hol_expire_carry(null,'2027-04-01') as expired_after;
select pg_temp.av('E1','2027') as e1_28_plus_5_minus_2_minus_3, pg_temp.av('E2','2027') as e2_28_plus_3_5_minus_3_5, pg_temp.av('E3','2027') as e3_used_more_than_carried;
select hol_expire_carry(null,'2027-06-01') as repeat_zero;
select entry_type, quantity from hol_ledger where employee_id=pg_temp.eid('E2') and entry_type='expiry';

\echo === D. daily job wrapper
select hol_run_daily_jobs('2027-06-01');
