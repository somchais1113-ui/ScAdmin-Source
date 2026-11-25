-- SCWork Admin V2.1.35 — Phase 04 / controlled Public Selling Rate publishing.
-- ADDITIVE, run AFTER migrations 001, 002 and 003. No seed prices. No supplier cost or private job data exposed.
-- Test on staging with Owner/Editor/Viewer and anon before running in Production.

create table if not exists public.scwork_rate_card_versions (
 id uuid primary key default gen_random_uuid(),
 version text not null unique check (version ~ '^[A-Za-z0-9._-]{1,45}$'),
 card jsonb not null,
 cost_profile_id uuid not null references public.scwork_cost_profiles(id),
 status text not null default 'draft' check(status in ('draft','approved','published','superseded')),
 reason text not null check(length(trim(reason)) between 16 and 1000),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 approved_by uuid references auth.users(id),
 approved_at timestamptz,
 approval_reason text,
 published_by uuid references auth.users(id),
 published_at timestamptz,
 source_version_id uuid references public.scwork_rate_card_versions(id)
);
create index if not exists scwork_rate_card_versions_latest on public.scwork_rate_card_versions(created_at desc);
create unique index if not exists scwork_rate_card_only_one_published on public.scwork_rate_card_versions(status) where status='published';
alter table public.scwork_rate_card_versions enable row level security;
revoke all on public.scwork_rate_card_versions from public, anon, authenticated;
grant select on public.scwork_rate_card_versions to authenticated;
drop policy if exists "rate card history private MFA staff" on public.scwork_rate_card_versions;
create policy "rate card history private MFA staff" on public.scwork_rate_card_versions
 for select to authenticated using (
  (select auth.jwt()->>'aal')='aal2' and exists (
   select 1 from public.scwork_admin_members m where m.user_id=(select auth.uid()) and m.active
  )
 );

create table if not exists public.scwork_rate_card_events (
 id bigint generated always as identity primary key,
 rate_card_id uuid not null references public.scwork_rate_card_versions(id),
 event_type text not null check(event_type in ('submitted','approved','published','superseded','rollback')),
 actor uuid not null references auth.users(id),
 event_time timestamptz not null default now(),
 detail jsonb not null default '{}'::jsonb
);
create index if not exists scwork_rate_card_events_latest on public.scwork_rate_card_events(event_time desc);
alter table public.scwork_rate_card_events enable row level security;
revoke all on public.scwork_rate_card_events from public, anon, authenticated;
grant select on public.scwork_rate_card_events to authenticated;
drop policy if exists "rate card audit private MFA staff" on public.scwork_rate_card_events;
create policy "rate card audit private MFA staff" on public.scwork_rate_card_events
 for select to authenticated using ((select auth.jwt()->>'aal')='aal2' and exists(
  select 1 from public.scwork_admin_members m where m.user_id=(select auth.uid()) and m.active));

-- PUBLIC SURFACE: exactly one row, approved selling rates only. No costs, margins,
-- supplier documents, owner identifiers, customer or internal audit details.
create table if not exists public.scwork_public_rate_card_live (
 id smallint primary key default 1 check(id=1),
 version text not null,
 card jsonb not null,
 published_at timestamptz not null
);
alter table public.scwork_public_rate_card_live enable row level security;
revoke all on public.scwork_public_rate_card_live from public, anon, authenticated;
grant select on public.scwork_public_rate_card_live to anon, authenticated;
drop policy if exists "public may read only published selling snapshot" on public.scwork_public_rate_card_live;
create policy "public may read only published selling snapshot"
 on public.scwork_public_rate_card_live for select to anon, authenticated using (id=1);

-- Helpers are not callable through the public Data API. Strictly validate the exported
-- Pricing Master SELLING CARD (not a private Cost Profile or private cost draft).
create or replace function public.scwork_card_assert_keys(p_obj jsonb, p_keys text[])
returns void language plpgsql set search_path='' as $$
declare k text;
begin
 if p_obj is null or jsonb_typeof(p_obj)<>'object' then raise exception 'Expected JSON object'; end if;
 for k in select jsonb_object_keys(p_obj) loop
  if not (k=any(p_keys)) then raise exception 'Disallowed public card field: %',k; end if;
 end loop;
end $$;
revoke all on function public.scwork_card_assert_keys(jsonb,text[]) from public,anon,authenticated;

create or replace function public.scwork_card_validate(p_card jsonb)
returns void language plpgsql set search_path='' as $$
declare
  c jsonb; m jsonb; t jsonb; a jsonb; buyer jsonb; co jsonb;
  key_id text; mode text; tier_arr jsonb; prev_max numeric; prev_price numeric;
  mat_seen text[]:=array[]::text[]; add_seen text[]; cat jsonb;
  n numeric; low numeric; high numeric; k text; idx integer; area boolean;
  groups text[]:=array['paper-sticker','kraft-sticker','pp-white','pp-clear','pvc-sqm','vinyl-banner'];
begin
 if p_card is null or jsonb_typeof(p_card)<>'object' or length(p_card::text)>100000 then raise exception 'Invalid/oversized Public Rate Card'; end if;
 perform public.scwork_card_assert_keys(p_card,array['status','demonstrationOnly','version','approvedAt','vatRate','a3PlusSheet','categories']);
 if not (p_card ?& array['status','demonstrationOnly','version','approvedAt','vatRate','a3PlusSheet','categories']) then raise exception 'Missing required Public Rate Card metadata'; end if;
 if p_card->>'status'<>'approved' or p_card->'demonstrationOnly' is distinct from 'false'::jsonb then raise exception 'Only approved, non-demo cards can be submitted'; end if;
 if coalesce(p_card->>'version','') !~ '^[A-Za-z0-9._-]{1,45}$' then raise exception 'Invalid card version'; end if;
 if jsonb_typeof(p_card->'vatRate')<>'number' or (p_card->>'vatRate')::numeric<>0 then raise exception 'SCWork currently cannot charge output VAT'; end if;
 if jsonb_typeof(p_card->'approvedAt')<>'string' or (p_card->>'approvedAt')::timestamptz is null then raise exception 'Missing card source timestamp'; end if;
 perform public.scwork_card_assert_keys(p_card->'a3PlusSheet',array['usableWidthCm','usableHeightCm','gapCm']);
 if not (p_card->'a3PlusSheet' ?& array['usableWidthCm','usableHeightCm','gapCm']) then raise exception 'Missing print geometry field'; end if;
 for k in select unnest(array['usableWidthCm','usableHeightCm','gapCm']) loop
  if jsonb_typeof(p_card->'a3PlusSheet'->k)<>'number' then raise exception 'Invalid sheet dimension %',k; end if;
 end loop;
 if (p_card->'a3PlusSheet'->>'usableWidthCm')::numeric<=0 or (p_card->'a3PlusSheet'->>'usableHeightCm')::numeric<=0
    or (p_card->'a3PlusSheet'->>'gapCm')::numeric<0
    or (p_card->'a3PlusSheet'->>'usableWidthCm')::numeric>200
    or (p_card->'a3PlusSheet'->>'usableHeightCm')::numeric>300
    or (p_card->'a3PlusSheet'->>'gapCm')::numeric>10 then raise exception 'Invalid public print geometry'; end if;
 if jsonb_typeof(p_card->'categories')<>'array' or jsonb_array_length(p_card->'categories')<>1 then raise exception 'One sticker category expected'; end if;
 cat:=p_card->'categories'->0;
 perform public.scwork_card_assert_keys(cat,array['id','name','materials']);
 if not (cat ?& array['id','name','materials']) then raise exception 'Sticker category metadata incomplete'; end if;
 if cat->>'id'<>'sticker' or length(coalesce(cat->>'name','')) not between 2 and 100 then raise exception 'Invalid sticker category'; end if;
 if jsonb_typeof(cat->'materials')<>'array' or jsonb_array_length(cat->'materials') not between 1 and 6 then raise exception 'Choose between one and six sticker materials'; end if;
 for m in select value from jsonb_array_elements(cat->'materials') loop
  perform public.scwork_card_assert_keys(m,array['id','name','description','mode','unitLabel','minSheets','minAreaSqm','minQty','defaultQty','tiers','ratePerSqm','minimumCharge','addons','pricingMode','buyerRates']);
  if not (m ?& array['id','name','description','mode','unitLabel','tiers','minimumCharge','addons']) then raise exception 'Missing required material fields'; end if;
  key_id:=m->>'id'; mode:=m->>'mode';
  if key_id is null or not (key_id=any(groups)) or key_id=any(mat_seen) then raise exception 'Unknown or duplicated material %',key_id; end if;
  mat_seen:=array_append(mat_seen,key_id);
  area:=key_id in ('pvc-sqm','vinyl-banner');
  if mode<>case when area then 'area_sqm' else 'a3_sheet' end then raise exception 'Material mode mismatch for %',key_id; end if;
  if length(coalesce(m->>'name','')) not between 2 and 140 or length(coalesce(m->>'unitLabel','')) not between 1 and 45
      or length(coalesce(m->>'description',''))>450 or coalesce(m->>'description','') ~ '[0-9]+[[:space:]]*(฿|บาท)' then raise exception 'Invalid material copy or stale sample price in description'; end if;
  if jsonb_typeof(m->'minimumCharge')<>'number' or (m->>'minimumCharge')::numeric<0 or (m->>'minimumCharge')::numeric>1000000000 then raise exception 'Invalid minimum charge'; end if;
  if area then
    if not (m ?& array['minAreaSqm','ratePerSqm']) then raise exception 'Missing area rate keys'; end if;
    if jsonb_typeof(m->'minAreaSqm')<>'number' or jsonb_typeof(m->'ratePerSqm')<>'number' then raise exception 'Area reference and rate required'; end if;
    if (m->>'minAreaSqm')::numeric<=0 or (m->>'ratePerSqm')::numeric<=0 then raise exception 'Invalid area rates'; end if;
  else
    if not (m ?& array['minSheets','pricingMode']) then raise exception 'Missing A3 price guard'; end if;
    if jsonb_typeof(m->'minSheets')<>'number' or (m->>'minSheets')::numeric<=0 or mod((m->>'minSheets')::numeric,1)<>0
       or (m->>'minSheets')::numeric>1000000 or m->>'pricingMode'<>'tier_floor' then raise exception 'Invalid sheet minimum or tier guard'; end if;
  end if;
  if jsonb_typeof(m->'tiers')<>'array' or jsonb_array_length(m->'tiers') not between 1 and 24 then raise exception 'Missing/oversized tiers'; end if;
  prev_max:=null;prev_price:=null;idx:=0;
  for t in select value from jsonb_array_elements(m->'tiers') loop
    idx:=idx+1;
    perform public.scwork_card_assert_keys(t,array['min','max','price','label']);
    if not (t ?& array['min','max','price','label']) then raise exception 'Incomplete tier'; end if;
    if jsonb_typeof(t->'min')<>'number' or jsonb_typeof(t->'price')<>'number'
       or (t ? 'max') is false or jsonb_typeof(t->'max') not in ('number','null') then raise exception 'Malformed tier'; end if;
    low:=(t->>'min')::numeric; high:=case when t->'max'='null'::jsonb then null else (t->>'max')::numeric end;
    n:=(t->>'price')::numeric;
    if low<=0 or n<=0 or n>100000000 or length(coalesce(t->>'label',''))>100
       or (high is not null and high<low) then raise exception 'Invalid selling tier'; end if;
    if not area and (mod(low,1)<>0 or (high is not null and mod(high,1)<>0)) then raise exception 'Sheets must be integers'; end if;
    if idx>1 and (prev_max is null or low<>prev_max+1 or n>prev_price) then raise exception 'Tier gap or non-monotonic rates'; end if;
    if idx=1 and low<>(case when area then (m->>'minAreaSqm')::numeric else (m->>'minSheets')::numeric end) then raise exception 'First tier does not match billing minimum'; end if;
    prev_max:=high;prev_price:=n;
  end loop;
  if prev_max is not null then raise exception 'Last tier must be open-ended'; end if;
  if area and (jsonb_array_length(m->'tiers')<>1 or (m->'tiers'->0->>'price')::numeric<>(m->>'ratePerSqm')::numeric) then raise exception 'Area rate inconsistent with tier'; end if;
  if m ? 'addons' and jsonb_typeof(m->'addons')<>'array' then raise exception 'Addons must be array'; end if;
  if jsonb_array_length(coalesce(m->'addons','[]'::jsonb))>15 then raise exception 'Too many add-ons'; end if;
  add_seen:=array[]::text[];
  for a in select value from jsonb_array_elements(coalesce(m->'addons','[]'::jsonb)) loop
    perform public.scwork_card_assert_keys(a,array['id','name','type','price']);
    if coalesce(a->>'id','') !~ '^[a-z0-9_-]{2,45}$' or a->>'id'=any(add_seen)
       or length(coalesce(a->>'name','')) not between 2 and 110 or a->>'type' not in ('flat','per_unit')
       or jsonb_typeof(a->'price')<>'number' or (a->>'price')::numeric<0 or (a->>'price')::numeric>100000000 then raise exception 'Invalid/duplicate add-on'; end if;
    add_seen:=array_append(add_seen,a->>'id');
  end loop;
  if m ? 'buyerRates' then
   perform public.scwork_card_assert_keys(m->'buyerRates',array['company']);
   co:=m->'buyerRates'->'company';
   perform public.scwork_card_assert_keys(co,array['tiers','ratePerSqm','minimumCharge','addons']);
   if not (co ?& array['tiers','minimumCharge','addons']) then raise exception 'Missing B2B price fields'; end if;
   if jsonb_typeof(co->'minimumCharge')<>'number' or (co->>'minimumCharge')::numeric<0 then raise exception 'Invalid B2B minimum charge'; end if;
   if jsonb_typeof(co->'tiers')<>'array' or jsonb_array_length(co->'tiers')<>jsonb_array_length(m->'tiers') then raise exception 'B2B tier count mismatch'; end if;
   for idx in 0..jsonb_array_length(co->'tiers')-1 loop
    t:=co->'tiers'->idx;buyer:=m->'tiers'->idx;
    perform public.scwork_card_assert_keys(t,array['min','max','price','label']);
    if not (t ?& array['min','max','price','label']) then raise exception 'Missing B2B tier fields'; end if;
    if jsonb_typeof(t->'price')<>'number' or (t->>'price')::numeric<=0 or (t->>'price')::numeric>100000000
       or (t->'min') is distinct from (buyer->'min') or (t->'max') is distinct from (buyer->'max')
       then raise exception 'B2B tier boundary or price mismatch'; end if;
   end loop;
   if area then
    if jsonb_typeof(co->'ratePerSqm')<>'number' or (co->>'ratePerSqm')::numeric<>(co->'tiers'->0->>'price')::numeric then raise exception 'B2B area tier inconsistent'; end if;
   end if;
   if jsonb_typeof(co->'addons')<>'array' or jsonb_array_length(co->'addons')>15 then raise exception 'Invalid B2B addons'; end if;
   for a in select value from jsonb_array_elements(co->'addons') loop
    perform public.scwork_card_assert_keys(a,array['id','name','type','price']);
    if jsonb_typeof(a->'price')<>'number' or (a->>'price')::numeric<0 or (a->>'price')::numeric>100000000
     or not exists(select 1 from jsonb_array_elements(coalesce(m->'addons','[]'::jsonb)) as x(value) where x.value->>'id'=a->>'id' and x.value->>'type'=a->>'type')
     then raise exception 'Invalid B2B add-on'; end if;
   end loop;
  end if;
 end loop;
end $$;
revoke all on function public.scwork_card_validate(jsonb) from public,anon,authenticated;

-- Every mutation is server-side, with an explicit MFA/role gate and immutable audit log.
create or replace function public.scwork_rate_card_submit(p_card jsonb, p_cost_profile_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); rid uuid;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2' or not exists(
  select 1 from public.scwork_admin_members m where m.user_id=actor and m.active and m.role in ('owner','editor'))
 then raise exception 'Owner/Editor with MFA required'; end if;
 if not exists (select 1 from public.scwork_cost_profiles p where p.id=p_cost_profile_id and p.status='approved')
 then raise exception 'Approved Cost Profile reference required'; end if;
 if length(trim(coalesce(p_reason,''))) not between 16 and 1000 then raise exception 'Source / pricing rationale 16-1000 characters required'; end if;
 perform public.scwork_card_validate(p_card);
 insert into public.scwork_rate_card_versions(version,card,cost_profile_id,reason,created_by)
 values(p_card->>'version',p_card,p_cost_profile_id,trim(p_reason),actor) returning id into rid;
 insert into public.scwork_rate_card_events(rate_card_id,event_type,actor,detail)
 values(rid,'submitted',actor,pg_catalog.jsonb_build_object('version',p_card->>'version','cost_profile_id',p_cost_profile_id));
 return rid;
end $$;
revoke all on function public.scwork_rate_card_submit(jsonb,uuid,text) from public,anon;
grant execute on function public.scwork_rate_card_submit(jsonb,uuid,text) to authenticated;

create or replace function public.scwork_rate_card_approve(p_id uuid,p_reason text,p_ack text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); r public.scwork_rate_card_versions;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2' or not exists(
  select 1 from public.scwork_admin_members m where m.user_id=actor and m.active and m.role='owner')
 then raise exception 'Owner with MFA required'; end if;
 if p_ack is distinct from 'MARGIN_VERIFIED' or length(trim(coalesce(p_reason,''))) not between 16 and 1000
 then raise exception 'Independent margin review, cost source and reason required'; end if;
 select * into r from public.scwork_rate_card_versions where id=p_id for update;
 if not found or r.status<>'draft' then raise exception 'Only draft can be approved'; end if;
 if not exists(select 1 from public.scwork_cost_profiles p where p.id=r.cost_profile_id and p.status='approved') then raise exception 'Source profile no longer approved'; end if;
 perform public.scwork_card_validate(r.card);
 update public.scwork_rate_card_versions set status='approved',approved_by=actor,approved_at=now(),approval_reason=trim(p_reason) where id=r.id;
 insert into public.scwork_rate_card_events(rate_card_id,event_type,actor,detail)
 values(r.id,'approved',actor,pg_catalog.jsonb_build_object('reason',trim(p_reason),'manual_margin_review',true));
end $$;
revoke all on function public.scwork_rate_card_approve(uuid,text,text) from public,anon;
grant execute on function public.scwork_rate_card_approve(uuid,text,text) to authenticated;

-- Transactionally move public pointer. Approval does not automatically Publish.
create or replace function public.scwork_rate_card_publish(p_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); r public.scwork_rate_card_versions; prior uuid;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2' or not exists (
  select 1 from public.scwork_admin_members m where m.user_id=actor and m.active and m.role='owner')
 then raise exception 'Owner with MFA required'; end if;
 if length(trim(coalesce(p_reason,''))) not between 16 and 1000 then raise exception 'Publishing reason required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(21434944);
 select * into r from public.scwork_rate_card_versions where id=p_id for update;
 if not found or r.status<>'approved' or r.approved_at is null then raise exception 'Only reviewed card may publish'; end if;
 perform public.scwork_card_validate(r.card);
 select id into prior from public.scwork_rate_card_versions where status='published' for update;
 if prior is not null then
  update public.scwork_rate_card_versions set status='superseded' where id=prior;
  insert into public.scwork_rate_card_events(rate_card_id,event_type,actor,detail)
  values(prior,'superseded',actor,pg_catalog.jsonb_build_object('replaced_by',r.version));
 end if;
 update public.scwork_rate_card_versions set status='published',published_by=actor,published_at=now() where id=p_id;
 insert into public.scwork_public_rate_card_live(id,version,card,published_at)
 values(1,r.version,r.card,now())
 on conflict(id) do update set version=excluded.version,card=excluded.card,published_at=excluded.published_at;
 insert into public.scwork_rate_card_events(rate_card_id,event_type,actor,detail)
 values(r.id,'published',actor,pg_catalog.jsonb_build_object('reason',trim(p_reason),'replaces',prior));
end $$;
revoke all on function public.scwork_rate_card_publish(uuid,text) from public,anon;
grant execute on function public.scwork_rate_card_publish(uuid,text) to authenticated;

-- Rollback means a NEW published release cloned from a prior approved/superseded card,
-- preserving the former public change history. Never silently overwrite release history.
create or replace function public.scwork_rate_card_rollback(p_prior_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); old public.scwork_rate_card_versions; current_id uuid; fresh_id uuid;
 v_code text; v_card jsonb;
begin
 if actor is null or (select auth.jwt()->>'aal') is distinct from 'aal2' or not exists (
  select 1 from public.scwork_admin_members m where m.user_id=actor and m.active and m.role='owner')
 then raise exception 'Owner with MFA required'; end if;
 if length(trim(coalesce(p_reason,''))) not between 16 and 1000 then raise exception 'Rollback reason required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(21434944);
 select * into old from public.scwork_rate_card_versions where id=p_prior_id for update;
 if not found or old.status not in ('approved','superseded') or old.approved_at is null then raise exception 'Choose a previously approved non-live rate card'; end if;
 perform public.scwork_card_validate(old.card);
 if not exists(select 1 from public.scwork_cost_profiles p where p.id=old.cost_profile_id and p.status in ('approved','superseded'))
 then raise exception 'Previous Cost Profile missing'; end if;
 v_code:='RB-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISS')||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,6);
 v_card:=pg_catalog.jsonb_set(pg_catalog.jsonb_set(old.card,'{version}',to_jsonb(v_code)),'{approvedAt}',to_jsonb(now()::text));
 perform public.scwork_card_validate(v_card);
 select id into current_id from public.scwork_rate_card_versions where status='published' for update;
 if current_id is not null then
  update public.scwork_rate_card_versions set status='superseded' where id=current_id;
  insert into public.scwork_rate_card_events(rate_card_id,event_type,actor,detail)
  values(current_id,'superseded',actor,pg_catalog.jsonb_build_object('rollback_to_source',old.id));
 end if;
 insert into public.scwork_rate_card_versions(version,card,cost_profile_id,status,reason,created_by,approved_by,approved_at,approval_reason,published_by,published_at,source_version_id)
 values(v_code,v_card,old.cost_profile_id,'published',trim(p_reason),actor,actor,now(),'Rollback to independently reviewed prior rate card',actor,now(),old.id)
 returning id into fresh_id;
 insert into public.scwork_public_rate_card_live(id,version,card,published_at)
 values(1,v_code,v_card,now())
 on conflict(id) do update set version=excluded.version,card=excluded.card,published_at=excluded.published_at;
 insert into public.scwork_rate_card_events(rate_card_id,event_type,actor,detail)
 values(fresh_id,'rollback',actor,pg_catalog.jsonb_build_object('source_version_id',old.id,'source_version',old.version,'reason',trim(p_reason),'replaces',current_id));
 return fresh_id;
end $$;
revoke all on function public.scwork_rate_card_rollback(uuid,text) from public,anon;
grant execute on function public.scwork_rate_card_rollback(uuid,text) to authenticated;

-- Sanity checks to run as distinct Auth users after migration:
-- * anon GET scwork_public_rate_card_live -> [] until first publication, then ONE public card only
-- * anon SELECT scwork_rate_card_versions / scwork_rate_card_events -> permission denied
-- * authenticated AAL1 must not SELECT history or call any mutation
-- * authenticated AAL2 viewer cannot submit, approve, publish or roll back
-- * authenticated AAL2 editor can submit, cannot approve/publish/roll back
-- * authenticated AAL2 owner can approve/publish/rollback, produces append-only event history
-- * Published card has vatRate=0 and contains no Supplier, cost, margin or customer fields
