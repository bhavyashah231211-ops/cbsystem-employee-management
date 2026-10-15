-- Approval flow tests (Step 4). Run on an EMPTY test database after schema.sql. Expect the ERROR lines marked in the section comments.
\set QUIET on
with b as (insert into hol_businesses(slug,name,staff_key_hash,owner_pin_hash) values ('t','Test','x','x') returning id)
select hol_seed_business(id) from b \gset
insert into hol_employees(business_id,employee_number,full_name,role,employment_start)
 select id,n,n,r,'2020-01-01' from hol_businesses, (values ('M1','manager'),('M2','manager'),('H1','hr'),('E1','employee'),('E3','employee')) v(n,r) where slug='t';
create function pg_temp.biz() returns uuid language sql as $$ select id from hol_businesses where slug='t' $$;
create function pg_temp.eid(n text) returns uuid language sql as $$ select id from hol_employees where employee_number=n $$;
create function pg_temp.typ() returns uuid language sql as $$ select id from hol_leave_types where code='annual' and business_id=pg_temp.biz() $$;
create function pg_temp.yr() returns uuid language sql as $$ select id from hol_leave_years where business_id=pg_temp.biz() limit 1 $$;
create function pg_temp.avail(n text) returns numeric language sql as $$ select hol_available(pg_temp.biz(),pg_temp.eid(n),pg_temp.typ(),pg_temp.yr()) $$;
create function pg_temp.sub(n text, d1 date, d2 date, appr text) returns jsonb language sql as $$
  select hol_submit_request(pg_temp.biz(), pg_temp.eid(n), pg_temp.typ(), null, d1, d2, null, null, (d2-d1+1)::numeric, null, '{}'::jsonb,
   (select jsonb_agg(jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'units',1,'leave_year_id',pg_temp.yr())) from generate_series(d1,d2,'1 day') d),
   true,true,false,pg_temp.eid(appr)) $$;
create function pg_temp.dec(rid uuid, actor text, decision text, ver int, ovr boolean default false) returns jsonb language sql as $$
  select hol_decide_request(pg_temp.biz(), rid, pg_temp.eid(actor), decision, 'c', ver, ovr) $$;
create function pg_temp.st(rid uuid) returns text language sql as $$ select status||' v'||version from hol_requests where id=rid $$;
select hol_post_entry(pg_temp.biz(),pg_temp.eid('E1'),pg_temp.typ(),pg_temp.yr(),'allocation',28,'a1',null,null) \gset
select hol_post_entry(pg_temp.biz(),pg_temp.eid('E3'),pg_temp.typ(),pg_temp.yr(),'allocation',5,'a3',null,null) \gset

\echo === A. approve flow
select (pg_temp.sub('E1','2027-05-10','2027-05-14','M1')->>'request_id')::uuid as r1 \gset
\echo -- not the approver (M2):
select pg_temp.dec(:'r1','M2','approved',1);
\echo -- own request (E1):
select pg_temp.dec(:'r1','E1','approved',1);
\echo -- stale version:
select pg_temp.dec(:'r1','M1','approved',99);
\echo -- approve:
select pg_temp.dec(:'r1','M1','approved',1);
select pg_temp.avail('E1') as available_should_be_23;
\echo -- decide again:
select pg_temp.dec(:'r1','M1','approved',2);

\echo === B. reject leaves the balance alone
select (pg_temp.sub('E1','2027-06-01','2027-06-03','M1')->>'request_id')::uuid as r2 \gset
select pg_temp.dec(:'r2','M1','rejected',1)->>'status' as status;
select pg_temp.avail('E1') as available_still_23;

\echo === C. changes requested sends it back to draft, employee can cancel the draft
select (pg_temp.sub('E1','2027-07-01','2027-07-01','M1')->>'request_id')::uuid as r3 \gset
select pg_temp.dec(:'r3','M1','changes_requested',1)->>'status' as status;
select hol_cancel_request(pg_temp.biz(), :'r3', pg_temp.eid('E1'))->>'status' as draft_cancelled;

\echo === D. balance re-checked at approval time
select (pg_temp.sub('E3','2027-08-02','2027-08-04','M1')->>'request_id')::uuid as r4 \gset
select hol_post_entry(pg_temp.biz(),pg_temp.eid('E3'),pg_temp.typ(),pg_temp.yr(),'adjustment',-4,'adj3',null,'correction') \gset
select pg_temp.dec(:'r4','M1','approved',1);
select pg_temp.st(:'r4') as r4_still_pending;

\echo === E. cancelling approved leave
select hol_cancel_approved(pg_temp.biz(), :'r1', pg_temp.eid('E1'), pg_temp.eid('M1'), 'plans changed')->>'status' as after_request;
select pg_temp.avail('E1') as still_23_until_approved;
\echo -- changes_requested not valid for a cancellation:
select pg_temp.dec(:'r1','M1','changes_requested',3);
\echo -- decline the cancellation, leave stays approved:
select pg_temp.dec(:'r1','M1','rejected',3)->>'status' as status;
select hol_cancel_approved(pg_temp.biz(), :'r1', pg_temp.eid('E1'), pg_temp.eid('M1'), null)->>'status' as asked_again;
select pg_temp.dec(:'r1','M1','approved',5)->>'status' as status;
select pg_temp.avail('E1') as available_back_to_28;
\echo -- cancelled leave cannot be cancelled again:
select hol_cancel_approved(pg_temp.biz(), :'r1', pg_temp.eid('E1'), pg_temp.eid('M1'), null);

\echo === F. delegation and override
insert into hol_delegations(business_id,from_id,to_id,starts_on,ends_on) values (pg_temp.biz(),pg_temp.eid('M1'),pg_temp.eid('M2'),current_date-1,current_date+7);
insert into hol_delegations(business_id,from_id,to_id,starts_on,ends_on) values (pg_temp.biz(),pg_temp.eid('M1'),pg_temp.eid('H1'),current_date-10,current_date-3);
select (pg_temp.sub('E1','2027-09-06','2027-09-07','M1')->>'request_id')::uuid as r5 \gset
\echo -- expired delegation (H1):
select pg_temp.dec(:'r5','H1','approved',1);
\echo -- active delegate (M2):
select pg_temp.dec(:'r5','M2','approved',1)->>'status' as status;
select (pg_temp.sub('E1','2027-10-04','2027-10-04','M1')->>'request_id')::uuid as r6 \gset
\echo -- HR override:
select pg_temp.dec(:'r6','H1','approved',1,true)->>'status' as status;

\echo === Integrity
select count(*) as cached_balances_out_of_step from hol_balances b where b.cached_available <> hol_available(b.business_id,b.employee_id,b.leave_type_id,b.leave_year_id);
select entry_type, quantity from hol_ledger where employee_id=pg_temp.eid('E1') order by created_at;
select count(*) as decisions_recorded from hol_approval_decisions;
select count(*) as unprocessed_outbox_events from hol_outbox where processed_at is null;
-- leave one pending request for the concurrency test
select (pg_temp.sub('E1','2027-11-01','2027-11-02','M1')->>'request_id') as rc \gset
\o /tmp/rc.txt
\echo :rc
\o
