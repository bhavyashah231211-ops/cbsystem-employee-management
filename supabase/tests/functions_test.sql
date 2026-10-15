-- Database tests for the transaction functions. Run on an EMPTY test database, never on production:
--   psql -d yourtestdb -f schema.sql && psql -d yourtestdb -f tests/functions_test.sql
-- Expected: allocation repeat returns f; overlap, insufficient balance, total mismatch, second cancel,
-- update/delete on ledger and audit, and a positive booking all produce ERRORs; the no-approval request books -1.
\set ON_ERROR_STOP off
\set QUIET on
with b as (insert into hol_businesses(slug,name,staff_key_hash,owner_pin_hash) values ('t','Test','x','x') returning id)
select hol_seed_business(id) from b;
create temp table ctx as select
  (select id from hol_businesses where slug='t') biz,
  (select id from hol_leave_types where code='annual' and business_id=(select id from hol_businesses where slug='t')) typ,
  (select id from hol_leave_years limit 1) yr;
insert into hol_employees(business_id,employee_number,full_name,role,employment_start)
 select biz,'M1','Mgr','manager','2020-01-01' from ctx;
insert into hol_employees(business_id,employee_number,full_name,employment_start,manager_id)
 select biz,'E1','Emp','2020-01-01',(select id from hol_employees where employee_number='M1') from ctx;
create temp table e as select id from hol_employees where employee_number='E1';
create temp table m as select id from hol_employees where employee_number='M1';

\echo === allocation (28), then repeat with same key must be a no-op
select hol_post_entry(biz,(select id from e),typ,yr,'allocation',28,'alloc:1',null,null) as first from ctx;
select hol_post_entry(biz,(select id from e),typ,yr,'allocation',28,'alloc:1',null,null) as repeat from ctx;
select hol_available(biz,(select id from e),typ,yr) as available_28 from ctx;

\echo === submit 5 days (pending, no deduction yet)
select hol_submit_request(biz,(select id from e),typ,null,'2027-05-10','2027-05-14',null,null,5,'hols','{}'::jsonb,
 jsonb_build_array(
  jsonb_build_object('date','2027-05-10','units',1,'leave_year_id',yr),
  jsonb_build_object('date','2027-05-11','units',1,'leave_year_id',yr),
  jsonb_build_object('date','2027-05-12','units',1,'leave_year_id',yr),
  jsonb_build_object('date','2027-05-13','units',1,'leave_year_id',yr),
  jsonb_build_object('date','2027-05-14','units',1,'leave_year_id',yr)),
 true,true,false,(select id from m)) as submit_ok from ctx;
select status, requested_units from hol_requests;
select count(*) as steps from hol_approval_steps;
select count(*) as approver_notifications from hol_notifications;
select hol_available(biz,(select id from e),typ,yr) as available_still_28 from ctx;

\echo === overlapping request must fail with 23P01
select hol_submit_request(biz,(select id from e),typ,null,'2027-05-12','2027-05-12',null,null,1,null,'{}'::jsonb,
 jsonb_build_array(jsonb_build_object('date','2027-05-12','units',1,'leave_year_id',yr)),true,true,false,(select id from m)) from ctx;

\echo === request more than remaining (28 - 5 pending = 23) must fail INSUFFICIENT_BALANCE
select hol_submit_request(biz,(select id from e),typ,null,'2027-06-01','2027-06-30',null,null,24,null,'{}'::jsonb,
 (select jsonb_agg(jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'units',1,'leave_year_id',yr)) from generate_series('2027-06-01'::date,'2027-06-24','1 day') d),
 true,true,false,(select id from m)) from ctx;

\echo === total mismatch (units says 2, days sum 1) must fail at commit
select hol_submit_request(biz,(select id from e),typ,null,'2027-07-01','2027-07-01',null,null,2,null,'{}'::jsonb,
 jsonb_build_array(jsonb_build_object('date','2027-07-01','units',1,'leave_year_id',yr)),true,true,false,(select id from m)) from ctx;

\echo === cancel the pending request, then cancelling again must fail
select hol_cancel_request(biz,(select id from hol_requests limit 1),(select id from e)) from ctx;
select hol_cancel_request(biz,(select id from hol_requests limit 1),(select id from e)) from ctx;
select status from hol_requests;
select status from hol_approval_steps;

\echo === ledger and audit are append-only
update hol_ledger set quantity=99;
delete from hol_audit_log;

\echo === sign convention: positive booking rejected
select hol_post_entry(biz,(select id from e),typ,yr,'booking',5,'bad:1',null,null) from ctx;

\echo === no-approval path books straight into the ledger
update hol_leave_types set requires_approval=false where code='unpaid';
select hol_submit_request(biz,(select id from e),typ,null,'2027-09-01','2027-09-01',null,null,1,null,'{}'::jsonb,
 jsonb_build_array(jsonb_build_object('date','2027-09-01','units',1,'leave_year_id',yr)),false,true,false,null) as auto_approved from ctx;
select entry_type, quantity from hol_ledger order by created_at;
select hol_available(biz,(select id from e),typ,yr) as available_27 from ctx;
select cached_available from hol_balances;
