# SCWork Admin Deploy V2.1.32

`admin-deploy/` is the **only** directory to host on Vercel as the Admin site.
`admin-setup/` contains private setup documentation and a SQL migration—do NOT deploy it.

1. Read `admin-setup/README_ADMIN.md`.
2. Provision your own Supabase project; run the migration after review.
3. In `admin-deploy/config.js`, set Project URL and public publishable/anon key only. Never embed service_role secrets.
4. Create an Auth owner user, assign its UUID to `scwork_admin_members` via the database editor, and enroll MFA at first login.
5. Deploy `admin-deploy/` as a **separate** Vercel project/subdomain; keep the public website independent.
6. Verify RLS, MFA, permissions and a private evidence file before using real data.

Automatic public rate publishing is intentionally disabled in this phase.
