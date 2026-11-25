-- SCWork Admin V2.1.34 / PHASE 03: PRIVATE JOB PROFITABILITY
-- ADDITIVE migration. Run AFTER 001 and 002. Review and back up before use.
-- No table here is granted to anon, and nothing writes to published selling rates.
-- All mutations pass through MFA-and-role-checked SECURITY DEFINER functions.
BEGIN;

create table if not exists public.scwork_jobs (
 id uuid primary key default gen_random_uuid(),
 job_code text not null unique check(length(trim(job_code)) between 3 and 60),
 customer_label text not null check(length(trim(customer_label)) between 2 and 120),
 buyer_type text not null check(buyer_type in ('b2b','b2c')),
 material_id text not null check(material_id in ('paper-sticker','kraft-sticker','pp-white','pp-clear','pvc-sqm','vinyl-banner')),
 quantity integer not null check(quantity between 1 and 100000000),
 job_date date not null,
 supplier_quote_id uuid references public.scwork_supplier_quotes(id),
 cost_profile_id uuid not null references public.scwork_cost_profiles(id),
 original_selling_price numeric(14,2) not null check(original_selling_price > 0),
 selling_price numeric(14,2) not null check(selling_price > 0),
 estimated_cost numeric(14,2) not null check(estimated_cost > 0),
 target_margin numeric(8,6) not null,
 estimated_breakdown jsonb not null check(jsonb_typeof(estimated_breakdown)='object'),
 estimate_inputs jsonb not null check(jsonb_typeof(estimate_inputs)='object'),
 status text not null default 'open' check(status in ('open','closed')),
 notes text not null default '' check(length(notes)<=1000),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 closed_by uuid references auth.users(id),
 closed_at timestamptz,
 close_reason text,
 updated_at timestamptz not null default now()
);
create index if not exists scwork_jobs_job_date on public.scwork_jobs(job_date desc,created_at desc);
create index if not exists scwork_jobs_status on public.scwork_jobs(status,created_at desc);
alter table public.scwork_jobs enable row level security;
revoke all on public.scwork_jobs from public,anon,authenticated;
grant select on public.scwork_jobs to authenticated;
create policy "mfa members read private jobs" on public.scwork_jobs for select to authenticated using (
 (select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.scwork_admin_members m
 where m.user_id=(select auth.uid()) and m.active)
);

-- Full replacement snapshots, not incremental additive expenses: no double-counting
-- when a corrected Actual Cost report is created. Previous revisions remain audit-visible.
create table if not exists public.scwork_job_actual_snapshots (
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null references public.scwork_jobs(id),
 revision integer not null check(revision between 1 and 1000000),
 breakdown jsonb not null check(jsonb_typeof(breakdown)='object'),
 total_cost numeric(14,2) not null check(total_cost>0),
 document_ref text not null check(length(trim(document_ref)) between 4 and 160),
 notes text not null default '' check(length(notes)<=1000),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(job_id,revision)
);
create index if not exists scwork_job_actual_latest on public.scwork_job_actual_snapshots(job_id,revision desc);
alter table public.scwork_job_actual_snapshots enable row level security;
revoke all on public.scwork_job_actual_snapshots from public,anon,authenticated;
grant select on public.scwork_job_actual_snapshots to authenticated;
create policy "mfa members read job actuals" on public.scwork_job_actual_snapshots for select to authenticated using (
 (select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.scwork_admin_members m
 where m.user_id=(select auth.uid()) and m.active)
);

create table if not exists public.scwork_job_events (
 id bigint generated always as identity primary key,
 job_id uuid not null references public.scwork_jobs(id),
 event_type text not null check(event_type in ('created','actual_revision','selling_price_revised','closed')),
 actor uuid not null references auth.users(id),
 event_time timestamptz not null default now(),
 detail jsonb not null default '{}'::jsonb
);
create index if not exists scwork_job_events_idx on public.scwork_job_events(job_id,event_time desc);
alter table public.scwork_job_events enable row level security;
revoke all on public.scwork_job_events from public,anon,authenticated;
grant select on public.scwork_job_events to authenticated;
create policy "mfa members read private job history" on public.scwork_job_events for select to authenticated using (
 (select auth.jwt()->>'aal')='aal2' and exists(select 1 from public.scwork_admin_members m
 where m.user_id=(select auth.uid()) and m.active)
);

-- Private job creation. Recalculates budget from the APPROVED Cost Profile on the server.
-- The browser NEVER supplies trusted computed totals or a synthetic approved status.
create or replace function public.scwork_create_job(
 p_code text,p_customer text,p_buyer text,p_material text,p_quantity integer,
 p_job_date date,p_profile_id uuid,p_quote_id uuid,p_sale numeric,
 p_direct jsonb,p_labor_hours jsonb,p_activity_hours numeric,p_notes text default ''
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 actor uuid := (select auth.uid());
 prof public.scwork_cost_profiles;
 src public.scwork_supplier_quotes;
 item jsonb; v_key text; v_raw jsonb; v_val numeric;
 v_monthly numeric:=0; v_labor numeric:=0; v_direct numeric:=0;
 v_rate numeric; v_hours numeric; v_cost numeric; v_risk numeric;
 v_oh numeric; v_admin numeric:=0; v_fee numeric; v_finance numeric:=0; v_target numeric;
 v_breakdown jsonb:='{}'::jsonb; v_id uuid;
 v_keys text[]:=array['supplier_total','extra_materials','packaging','outbound_freight','machine_energy','outside_services'];
 v_labor_keys text[]:=array['design','prepress','coordination','qc','packing','production'];
 v_num integer:=0;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2'
    or not exists(select 1 from public.scwork_admin_members m where m.user_id=actor and m.active and m.role in ('owner','editor'))
 then raise exception 'Active Owner/Editor with MFA required'; end if;
 if length(trim(coalesce(p_code,''))) not between 3 and 60 or length(trim(coalesce(p_customer,''))) not between 2 and 120
    or p_buyer not in ('b2c','b2b') or p_material not in ('paper-sticker','kraft-sticker','pp-white','pp-clear','pvc-sqm','vinyl-banner')
    or p_quantity is null or p_quantity<1 or p_quantity>100000000 or p_job_date is null
    or p_sale is null or p_sale<=0 or p_sale>100000000000 or scale(p_sale)>2
    or p_activity_hours is null or p_activity_hours<=0 or p_activity_hours>744
    or length(coalesce(p_notes,''))>1000
 then raise exception 'Invalid job details, activity hours or selling price'; end if;
 select * into prof from public.scwork_cost_profiles where id=p_profile_id for share;
 if not found or prof.status<>'approved' or prof.period_month>p_job_date
 then raise exception 'Use an approved Cost Profile effective no later than job date'; end if;
 if p_quote_id is not null then
   select * into src from public.scwork_supplier_quotes where id=p_quote_id;
   if not found or src.status<>'approved' or src.material_id<>p_material
   then raise exception 'Linked Supplier quote must be approved and match the material'; end if;
   if src.valid_until is not null and src.valid_until<p_job_date
   then raise exception 'Linked Supplier quote expired before job date'; end if;
 end if;
 if p_direct is null or jsonb_typeof(p_direct)<>'object'
    or p_labor_hours is null or jsonb_typeof(p_labor_hours)<>'object'
 then raise exception 'Direct cost and labor hour objects required'; end if;
 -- Accept EXACTLY the six direct monetary keys. No extras or missing fields.
 for v_key,v_raw in select key,value from jsonb_each(p_direct) loop
   if not (v_key=any(v_keys)) or jsonb_typeof(v_raw)<>'number'
   then raise exception 'Unexpected direct cost key or type: %',v_key; end if;
   v_val:=(v_raw #>> '{}')::numeric;
   if v_val<0 or v_val>100000000000 or scale(v_val)>2
   then raise exception 'Direct cost must be nonnegative money with <=2 decimals'; end if;
   v_direct:=v_direct+v_val; v_num:=v_num+1;
 end loop;
 for v_key in select unnest(v_keys) loop
   if not (p_direct ? v_key) then raise exception 'Missing cost component: %',v_key; end if;
 end loop;
 if v_num<>6 then raise exception 'Exactly six direct costs required'; end if;
 for item in select value from jsonb_array_elements(prof.overhead_lines) as e(value) loop
   v_monthly:=v_monthly + (item->>'amount')::numeric*(item->>'allocation')::numeric;
 end loop;
 if prof.productive_hours<=0 or v_monthly<=0 then raise exception 'Invalid approved overhead baseline'; end if;
 v_oh:=round(p_activity_hours*v_monthly/prof.productive_hours,2);
 for v_key,v_raw in select key,value from jsonb_each(p_labor_hours) loop
   if not (v_key=any(v_labor_keys)) or jsonb_typeof(v_raw)<>'number' then raise exception 'Unexpected labor hour key/type'; end if;
   v_hours:=(v_raw #>> '{}')::numeric;
   if v_hours<0 or v_hours>744 then raise exception 'Labor hours out of range'; end if;
   if v_hours>0 then
     select (value->>'rate')::numeric into v_rate from jsonb_array_elements(prof.labor_rates) as e(value)
       where value->>'role'=v_key;
     if v_rate is null then raise exception 'Missing hourly labor rate: %',v_key; end if;
     v_labor:=v_labor+v_hours*v_rate;
   end if;
 end loop;
 v_labor:=round(v_labor,2);
 v_risk:=round(((p_direct->>'supplier_total')::numeric+(p_direct->>'extra_materials')::numeric)*prof.risk_pct,2);
 if p_buyer='b2b' then
   v_admin:=prof.b2b_admin_fee;
   v_fee:=round(p_sale*prof.b2b_payment_fee,2);
   v_finance:=round(p_sale*prof.b2b_financing_rate*prof.b2b_credit_days/365,2);
   v_target:=prof.b2b_margin;
 else
   v_fee:=round(p_sale*prof.b2c_payment_fee,2);
   v_target:=prof.b2c_margin;
 end if;
 v_cost:=round(v_direct+v_risk+v_labor+v_oh+v_admin+v_fee+v_finance,2);
 if v_cost<=0 or v_cost>100000000000 then raise exception 'Estimated job cost invalid'; end if;
 v_breakdown:=p_direct||pg_catalog.jsonb_build_object('direct_labor',v_labor,'allocated_overhead',v_oh,
       'risk_reserve',v_risk,'b2b_admin_fee',v_admin,'payment_fee',v_fee,'financing_cost',v_finance);
 insert into public.scwork_jobs(job_code,customer_label,buyer_type,material_id,quantity,job_date,
    supplier_quote_id,cost_profile_id,original_selling_price,selling_price,estimated_cost,target_margin,
    estimated_breakdown,estimate_inputs,notes,created_by)
 values(trim(p_code),trim(p_customer),p_buyer,p_material,p_quantity,p_job_date,p_quote_id,p_profile_id,
    p_sale,p_sale,v_cost,v_target,v_breakdown,pg_catalog.jsonb_build_object('direct',p_direct,'labor_hours',p_labor_hours,'activity_hours',p_activity_hours),coalesce(p_notes,''),actor)
 returning id into v_id;
 insert into public.scwork_job_events(job_id,event_type,actor,detail) values(v_id,'created',actor,
    pg_catalog.jsonb_build_object('profile_id',p_profile_id,'estimate_cost',v_cost,'selling_price',p_sale,'linked_quote_id',p_quote_id));
 return v_id;
end $$;
revoke all on function public.scwork_create_job(text,text,text,text,integer,date,uuid,uuid,numeric,jsonb,jsonb,numeric,text) from public,anon;
grant execute on function public.scwork_create_job(text,text,text,text,integer,date,uuid,uuid,numeric,jsonb,jsonb,numeric,text) to authenticated;

-- Each new Actual Cost revision is the COMPLETE current set of costs, not an added delta.
-- Corrections append a new immutable revision and leave all previous values visible.
create or replace function public.scwork_record_job_actual(
 p_job_id uuid,p_actual jsonb,p_document_ref text,p_notes text default ''
) returns uuid language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=(select auth.uid()); r public.scwork_jobs;
 v_key text; v_raw jsonb; v_val numeric; v_total numeric:=0; v_rev integer; v_id uuid;
 v_keys text[]:=array['supplier_total','extra_materials','packaging','outbound_freight','machine_energy','outside_services','direct_labor','allocated_overhead','b2b_admin_fee','payment_fee','financing_cost'];
 v_count integer:=0;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2'
    or not exists(select 1 from public.scwork_admin_members m where m.user_id=actor and m.active and m.role in ('owner','editor'))
 then raise exception 'Active Owner/Editor with MFA required'; end if;
 if length(trim(coalesce(p_document_ref,''))) not between 4 and 160 or length(coalesce(p_notes,''))>1000
 then raise exception 'An actual cost reference (4+ chars) and valid notes are required'; end if;
 select * into r from public.scwork_jobs where id=p_job_id for update;
 if not found or r.status<>'open' then raise exception 'Only open jobs accept actual cost revisions'; end if;
 if p_actual is null or jsonb_typeof(p_actual)<>'object' then raise exception 'Actual cost object required'; end if;
 for v_key,v_raw in select key,value from jsonb_each(p_actual) loop
   if not (v_key=any(v_keys)) or jsonb_typeof(v_raw)<>'number'
   then raise exception 'Unexpected actual cost key/type: %',v_key; end if;
   v_val:=(v_raw #>> '{}')::numeric;
   if v_val<0 or v_val>100000000000 or scale(v_val)>2
   then raise exception 'Actual amounts must be nonnegative and max 2 decimals'; end if;
   v_total:=v_total+v_val; v_count:=v_count+1;
 end loop;
 for v_key in select unnest(v_keys) loop
   if not (p_actual ? v_key) then raise exception 'Missing actual component: %',v_key; end if;
 end loop;
 if v_count<>11 or v_total<=0 or v_total>100000000000
 then raise exception 'Complete all actual cost components with at least one positive amount'; end if;
 select coalesce(max(revision),0)+1 into v_rev from public.scwork_job_actual_snapshots where job_id=p_job_id;
 insert into public.scwork_job_actual_snapshots(job_id,revision,breakdown,total_cost,document_ref,notes,created_by)
 values(p_job_id,v_rev,p_actual,round(v_total,2),trim(p_document_ref),coalesce(p_notes,''),actor)
 returning id into v_id;
 insert into public.scwork_job_events(job_id,event_type,actor,detail)
 values(p_job_id,'actual_revision',actor,pg_catalog.jsonb_build_object('revision',v_rev,'total_cost',round(v_total,2),'document_ref',trim(p_document_ref)));
 return v_id;
end $$;
revoke all on function public.scwork_record_job_actual(uuid,jsonb,text,text) from public,anon;
grant execute on function public.scwork_record_job_actual(uuid,jsonb,text,text) to authenticated;

-- Approved/accepted selling price can change only by Owner, with reason; changes
-- are separately audited and do not overwrite the frozen original cost estimate.
create or replace function public.scwork_revise_job_sale(p_job_id uuid,p_sale numeric,p_reason text)
returns public.scwork_jobs language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); r public.scwork_jobs; v_prior numeric;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2' or not exists(
   select 1 from public.scwork_admin_members m where m.user_id=actor and m.active and m.role='owner')
 then raise exception 'Owner with MFA required'; end if;
 if p_sale is null or p_sale<=0 or p_sale>100000000000 or scale(p_sale)>2
   or length(trim(coalesce(p_reason,''))) not between 8 and 500
 then raise exception 'Valid price and reason (8-500 characters) required'; end if;
 select * into r from public.scwork_jobs where id=p_job_id for update;
 if not found or r.status<>'open' then raise exception 'Only open jobs can change selling price'; end if;
 v_prior:=r.selling_price;
 if p_sale=v_prior then raise exception 'Selling price has not changed'; end if;
 update public.scwork_jobs set selling_price=p_sale,updated_at=now() where id=p_job_id returning * into r;
 insert into public.scwork_job_events(job_id,event_type,actor,detail) values(p_job_id,'selling_price_revised',actor,
    pg_catalog.jsonb_build_object('previous_price',v_prior,'new_price',p_sale,'reason',trim(p_reason)));
 return r;
end $$;
revoke all on function public.scwork_revise_job_sale(uuid,numeric,text) from public,anon;
grant execute on function public.scwork_revise_job_sale(uuid,numeric,text) to authenticated;

create or replace function public.scwork_close_job(p_job_id uuid,p_reason text)
returns public.scwork_jobs language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());r public.scwork_jobs;v_actual numeric; v_actual_at timestamptz; v_price_revised_at timestamptz;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2' or not exists(
   select 1 from public.scwork_admin_members m where m.user_id=actor and m.active and m.role='owner')
 then raise exception 'Owner with MFA required'; end if;
 if length(trim(coalesce(p_reason,''))) not between 8 and 500
 then raise exception 'Closing a job requires a documented reason (8-500 characters)'; end if;
 select * into r from public.scwork_jobs where id=p_job_id for update;
 if not found or r.status<>'open' then raise exception 'Only open jobs can be closed'; end if;
 select a.total_cost,a.created_at into v_actual,v_actual_at from public.scwork_job_actual_snapshots a where a.job_id=p_job_id
 order by a.revision desc limit 1;
 select max(e.event_time) into v_price_revised_at from public.scwork_job_events e where e.job_id=p_job_id and e.event_type='selling_price_revised';
 if v_actual is null or v_actual<=0 then raise exception 'Complete actual cost snapshot required before close'; end if;
 if v_price_revised_at is not null and v_actual_at <= v_price_revised_at then
   raise exception 'Record a new actual cost snapshot AFTER selling price revision to recheck fees/credit';
 end if;
 update public.scwork_jobs set status='closed',closed_by=actor,closed_at=now(),close_reason=trim(p_reason),updated_at=now()
 where id=p_job_id returning * into r;
 insert into public.scwork_job_events(job_id,event_type,actor,detail) values(p_job_id,'closed',actor,
    pg_catalog.jsonb_build_object('actual_cost',v_actual,'selling_price',r.selling_price,'reason',trim(p_reason)));
 return r;
end $$;
revoke all on function public.scwork_close_job(uuid,text) from public,anon;
grant execute on function public.scwork_close_job(uuid,text) to authenticated;

-- No public SELECT, no direct browser INSERT/UPDATE/DELETE, no rate publishing.
-- RLS and RPC guard Owner/Editor/Viewer and aal2 (MFA) at the database boundary.
COMMIT;
