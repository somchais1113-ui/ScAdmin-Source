-- SCWork Admin V2.1.33 — ADDITIVE migration, run AFTER 001_scwork_admin.sql.
-- This migration NEVER modifies Supplier Quotes or the published selling rate table.
-- It creates private, immutable monthly cost snapshots and owner-only approval RPCs.
-- Recommended: test in staging; take backup; inspect SQL before running in production.

create table if not exists public.scwork_cost_profiles (
 id uuid primary key default gen_random_uuid(),
 period_month date not null check(extract(day from period_month)=1),
 productive_hours numeric(10,2) not null check(productive_hours>0 and productive_hours<=744),
 overhead_lines jsonb not null check(jsonb_typeof(overhead_lines)='array'),
 labor_rates jsonb not null check(jsonb_typeof(labor_rates)='array'),
 b2c_margin numeric(8,6) not null check(b2c_margin>=0 and b2c_margin<1),
 b2b_margin numeric(8,6) not null check(b2b_margin>=0 and b2b_margin<1),
 b2c_payment_fee numeric(8,6) not null check(b2c_payment_fee>=0 and b2c_payment_fee<1),
 b2b_payment_fee numeric(8,6) not null check(b2b_payment_fee>=0 and b2b_payment_fee<1),
 b2b_admin_fee numeric(14,2) not null check(b2b_admin_fee>=0 and b2b_admin_fee<=100000000),
 b2b_credit_days integer not null check(b2b_credit_days between 0 and 3650),
 b2b_financing_rate numeric(8,6) not null check(b2b_financing_rate>=0 and b2b_financing_rate<1),
 risk_pct numeric(8,6) not null check(risk_pct>=0 and risk_pct<1),
 notes text not null default '' check(length(notes)<=1200),
 status text not null default 'draft' check(status in ('draft','approved','superseded')),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 review_reason text
);
create index if not exists scwork_cost_period_status on public.scwork_cost_profiles(period_month desc,status);
create unique index if not exists scwork_cost_one_approved_month
 on public.scwork_cost_profiles(period_month) where status='approved';
alter table public.scwork_cost_profiles enable row level security;
revoke all on public.scwork_cost_profiles from public,anon,authenticated;
grant select on public.scwork_cost_profiles to authenticated;
create policy "private cost profiles require active member and MFA"
 on public.scwork_cost_profiles for select to authenticated
 using ((select auth.jwt()->>'aal')='aal2'
 and exists(select 1 from public.scwork_admin_members m
 where m.user_id=(select auth.uid()) and m.active));

create table if not exists public.scwork_cost_profile_events (
 id bigint generated always as identity primary key,
 profile_id uuid not null references public.scwork_cost_profiles(id),
 event_type text not null check(event_type in ('created','approved','superseded')),
 actor uuid not null references auth.users(id),
 event_time timestamptz not null default now(),
 detail jsonb not null default '{}'::jsonb
);
create index if not exists scwork_cost_audit_by_profile
 on public.scwork_cost_profile_events(profile_id,event_time desc);
alter table public.scwork_cost_profile_events enable row level security;
revoke all on public.scwork_cost_profile_events from public,anon,authenticated;
grant select on public.scwork_cost_profile_events to authenticated;
create policy "private cost audit requires active member and MFA"
 on public.scwork_cost_profile_events for select to authenticated
 using ((select auth.jwt()->>'aal')='aal2'
 and exists(select 1 from public.scwork_admin_members m
 where m.user_id=(select auth.uid()) and m.active));

-- A single RPC makes profile snapshots atomic, prevents partial data on invalid input,
-- and leaves every approved snapshot immutable for audit/rollback.
create or replace function public.scwork_create_cost_profile(
 p_period date,
 p_hours numeric,
 p_overheads jsonb,
 p_labor jsonb,
 p_b2c_margin numeric,
 p_b2b_margin numeric,
 p_b2c_fee numeric,
 p_b2b_fee numeric,
 p_b2b_admin numeric,
 p_credit_days integer,
 p_finance numeric,
 p_risk numeric,
 p_notes text default ''
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 actor uuid := (select auth.uid());
 v_id uuid;
 item jsonb;
 v_monthly numeric := 0;
 seen_roles text[] := array[]::text[];
 role_name text;
 val numeric;
 alloc numeric;
 value_txt text;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2'
    or not exists (select 1 from public.scwork_admin_members m where m.user_id=actor
       and m.active and m.role in ('owner','editor')) then
   raise exception 'Creating cost snapshot requires owner/editor with MFA';
 end if;
 if p_period is null or extract(day from p_period)<>1
    or p_hours is null or p_hours<=0 or p_hours>744 then
   raise exception 'Provide the first day of month and productive hours 0-744';
 end if;
 if p_overheads is null or jsonb_typeof(p_overheads)<>'array' then
   raise exception 'Overhead lines must be an array';
 end if;
 if jsonb_array_length(p_overheads)<1 or jsonb_array_length(p_overheads)>40 then
   raise exception 'Include 1 to 40 monthly overhead lines';
 end if;
 for item in select value from jsonb_array_elements(p_overheads) as e(value) loop
   if coalesce(jsonb_typeof(item),'null')<>'object' or length(trim(coalesce(item->>'label',''))) not between 2 and 100
      or coalesce(item->>'category','') not in ('facility','utilities','software','equipment','indirect_salary','general','insurance')
      or coalesce(jsonb_typeof(item->'amount'),'null') <> 'number' or coalesce(jsonb_typeof(item->'allocation'),'null') <> 'number' then
     raise exception 'Invalid overhead item/category';
   end if;
   val := (item->>'amount')::numeric;
   alloc := (item->>'allocation')::numeric;
   if val<0 or val>1000000000 or alloc<0 or alloc>1 then
     raise exception 'Overhead amount or allocation out of range';
   end if;
   v_monthly := v_monthly + val*alloc;
 end loop;
 if v_monthly<=0 then raise exception 'Business-allocated monthly overhead must be positive'; end if;
 if p_labor is null or jsonb_typeof(p_labor)<>'array' then
   raise exception 'Labor rates must be an array';
 end if;
 if jsonb_array_length(p_labor)<1 or jsonb_array_length(p_labor)>6 then
   raise exception 'Provide 1-6 labor hourly rates';
 end if;
 for item in select value from jsonb_array_elements(p_labor) as e(value) loop
   role_name := item->>'role';
   if coalesce(jsonb_typeof(item),'null')<>'object' or coalesce(role_name,'') not in ('design','prepress','coordination','qc','packing','production')
      or role_name = any(seen_roles) or coalesce(jsonb_typeof(item->'rate'),'null')<>'number' then
      raise exception 'Invalid or duplicated labor role';
   end if;
   val := (item->>'rate')::numeric;
   if val<=0 or val>1000000 then raise exception 'Hourly labor rate must be positive'; end if;
   seen_roles := array_append(seen_roles,role_name);
 end loop;
 if p_b2c_margin is null or p_b2b_margin is null or p_b2c_fee is null or p_b2b_fee is null
    or p_b2b_admin is null or p_credit_days is null or p_finance is null or p_risk is null then
   raise exception 'Complete all pricing controls';
 end if;
 if p_b2c_margin<0 or p_b2b_margin<0 or p_b2c_fee<0 or p_b2b_fee<0
    or p_finance<0 or p_risk<0 or p_b2b_admin<0 or p_b2b_admin>100000000
    or p_credit_days<0 or p_credit_days>3650
    or p_b2c_margin>=1 or p_b2b_margin>=1 or p_b2c_fee>=1 or p_b2b_fee>=1 or p_finance>=1 or p_risk>=1
    or (p_b2c_margin+p_b2c_fee)>=0.99
    or (p_b2b_margin+p_b2b_fee+p_finance*p_credit_days/365)>=0.99 then
   raise exception 'Pricing margins, fees, or credit costs exceed allowed bounds';
 end if;
 if length(coalesce(p_notes,''))>1200 then raise exception 'Notes exceed 1200 characters'; end if;
 insert into public.scwork_cost_profiles(period_month,productive_hours,overhead_lines,labor_rates,
  b2c_margin,b2b_margin,b2c_payment_fee,b2b_payment_fee,b2b_admin_fee,
  b2b_credit_days,b2b_financing_rate,risk_pct,notes,created_by)
 values (p_period,p_hours,p_overheads,p_labor,p_b2c_margin,p_b2b_margin,p_b2c_fee,p_b2b_fee,
         p_b2b_admin,p_credit_days,p_finance,p_risk,coalesce(p_notes,''),actor)
 returning id into v_id;
 insert into public.scwork_cost_profile_events(profile_id,event_type,actor,detail)
 values (v_id,'created',actor,jsonb_build_object('month',p_period,'monthly_overhead',round(v_monthly,2)));
 return v_id;
end $$;
revoke all on function public.scwork_create_cost_profile(date,numeric,jsonb,jsonb,numeric,numeric,numeric,numeric,numeric,integer,numeric,numeric,text)
 from public,anon;
grant execute on function public.scwork_create_cost_profile(date,numeric,jsonb,jsonb,numeric,numeric,numeric,numeric,numeric,integer,numeric,numeric,text) to authenticated;

create or replace function public.scwork_approve_cost_profile(p_id uuid,p_reason text)
 returns public.scwork_cost_profiles language plpgsql security definer set search_path='' as $$
declare actor uuid := (select auth.uid()); r public.scwork_cost_profiles; prior record; v_period date;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2'
    or not exists(select 1 from public.scwork_admin_members m
      where m.user_id=actor and m.active and m.role='owner') then
   raise exception 'Owner with MFA required for cost profile approval';
 end if;
 if length(trim(coalesce(p_reason,'')))<8 or length(p_reason)>500 then
   raise exception 'Approval requires a reason between 8 and 500 characters';
 end if;
 -- Lock the PERIOD BEFORE any profile row, avoiding concurrent-approval deadlocks.
 select period_month into v_period from public.scwork_cost_profiles where id=p_id;
 if not found then raise exception 'Cost profile not found'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('scwork-cost-'||v_period::text));
 select * into r from public.scwork_cost_profiles where id=p_id for update;
 if not found or r.status<>'draft' then raise exception 'Cost profile is not a draft'; end if;
 for prior in select id from public.scwork_cost_profiles
   where period_month=r.period_month and status='approved' for update loop
   update public.scwork_cost_profiles set status='superseded' where id=prior.id;
   insert into public.scwork_cost_profile_events(profile_id,event_type,actor,detail)
      values (prior.id,'superseded',actor,jsonb_build_object('replacement',p_id));
 end loop;
 update public.scwork_cost_profiles
   set status='approved',reviewed_by=actor,reviewed_at=now(),review_reason=trim(p_reason)
   where id=p_id returning * into r;
 insert into public.scwork_cost_profile_events(profile_id,event_type,actor,detail)
   values(p_id,'approved',actor,jsonb_build_object('month',r.period_month));
 return r;
end $$;
revoke all on function public.scwork_approve_cost_profile(uuid,text) from public,anon;
grant execute on function public.scwork_approve_cost_profile(uuid,text) to authenticated;

-- IMPORTANT: no public SELECT on costs; no browser write to cost profile tables;
-- no automatic publishing of selling rates; no secret/service_role key in the client.
