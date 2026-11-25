-- SCWork Phase 04 — SELECT-ONLY checks AFTER SQL 004.
-- If any critical test fails, DO NOT enable public-rate-config.js and do NOT publish a live card.
select 'private_history_anon_select_must_be_false' as test,
       not has_table_privilege('anon','public.scwork_rate_card_versions','SELECT') as passed
union all select 'private_history_anon_insert_must_be_false',
       not has_table_privilege('anon','public.scwork_rate_card_versions','INSERT')
union all select 'private_audit_anon_select_must_be_false',
       not has_table_privilege('anon','public.scwork_rate_card_events','SELECT')
union all select 'public_live_anon_read_must_be_true',
       has_table_privilege('anon','public.scwork_public_rate_card_live','SELECT')
union all select 'public_live_anon_write_must_be_false',
       not has_table_privilege('anon','public.scwork_public_rate_card_live','INSERT')
union all select 'public_live_anon_update_must_be_false',
       not has_table_privilege('anon','public.scwork_public_rate_card_live','UPDATE')
union all select 'submit_rpc_anon_execute_must_be_false',
       not has_function_privilege('anon','public.scwork_rate_card_submit(jsonb,uuid,text)','EXECUTE')
union all select 'approve_rpc_anon_execute_must_be_false',
       not has_function_privilege('anon','public.scwork_rate_card_approve(uuid,text,text)','EXECUTE')
union all select 'publish_rpc_anon_execute_must_be_false',
       not has_function_privilege('anon','public.scwork_rate_card_publish(uuid,text)','EXECUTE')
union all select 'rollback_rpc_anon_execute_must_be_false',
       not has_function_privilege('anon','public.scwork_rate_card_rollback(uuid,text)','EXECUTE');
-- RLS enforcement / owner, editor and viewer authorization must ALSO be tested with
-- distinct real Supabase Auth sessions at AAL1/AAL2; SQL Editor as postgres cannot emulate it.
select schemaname,tablename,policyname,roles,cmd
from pg_policies
where schemaname='public' and tablename in
 ('scwork_rate_card_versions','scwork_rate_card_events','scwork_public_rate_card_live')
order by tablename,policyname;
