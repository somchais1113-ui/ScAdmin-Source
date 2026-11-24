-- SCWork Phase 04 — SAFE SELECT-ONLY preflight; run BEFORE SQL 004.
-- This query does not alter any production data or disclose Supplier costs.
select '001_admin_members' as component, to_regclass('public.scwork_admin_members') is not null as exists_in_schema
union all select '002_cost_profiles',to_regclass('public.scwork_cost_profiles') is not null
union all select '003_jobs',to_regclass('public.scwork_jobs') is not null
union all select '003_actual_snapshots',to_regclass('public.scwork_job_actual_snapshots') is not null
union all select '004_rate_versions',to_regclass('public.scwork_rate_card_versions') is not null
union all select '004_public_live',to_regclass('public.scwork_public_rate_card_live') is not null;
