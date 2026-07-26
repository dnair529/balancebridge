-- ===========================================================================
-- Row-Level Security — defense in depth BEHIND the application's own scoping.
-- ===========================================================================
--
-- The app already scopes every query by a client_id derived server-side from
-- the session (src/auth/guards.ts resolveClientId — the access-control choke
-- point). That is, and remains, the primary control. This file exists so that
-- ONE forgotten `where client_id = ...` in a future route cannot leak another
-- client's financial records: the database refuses the rows as well.
--
-- What it is NOT: protection against an attacker who can execute arbitrary SQL
-- on the app's connection. Such an attacker can also call app.set_context()
-- and claim to be staff. RLS here defends against scoping BUGS, not against
-- code execution.
--
-- HOW THE POLICIES DECIDE
--   * GUC `app.current_role_name` — 'client' | 'staff' | 'admin' | 'service'
--   * GUC `app.current_client_id` — the client uuid for a 'client' connection
--   staff / admin / service  -> unrestricted (they legitimately work across
--                               clients; the app still scopes them by ?client=)
--   client                   -> only rows belonging to app.current_client_id
--   GUC unset / malformed    -> NO ROWS. Fails closed, deliberately.
--
-- ROLLOUT (see docs/SECURITY.md)
--   Phase 1 (this file, applied automatically after migrations): policies exist
--     and the restricted role `portal_app` is created. The app still connects
--     as the database OWNER, and a table owner is exempt from RLS unless the
--     table is FORCEd — so behaviour is unchanged and nothing can break.
--   Phase 2 (before real client data): a per-request hook sets the two GUCs on
--     the connection, DATABASE_URL switches to portal_app, and the policies go
--     live. Phase 2 is not safe to enable until that hook exists, because the
--     policies fail closed.
--
-- Idempotent: safe to run on every boot. Tables that do not exist yet are
-- skipped with a NOTICE rather than aborting the run.
--
-- Apply with:  node dist/db/apply-rls.js      (or: psql -f src/db/rls.sql)
-- psql alone does not create the login role; run
--   SELECT app.ensure_app_role('portal_app', 'a-strong-password');
-- afterwards, or let src/db/apply-rls.ts do it from APP_DB_ROLE/APP_DB_PASSWORD.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS app;
COMMENT ON SCHEMA app IS 'RLS helper functions. Not application data.';

-- --------------------------------------------------------------------------
-- Session context helpers
-- --------------------------------------------------------------------------

-- current_setting(..., true) returns NULL instead of erroring when the GUC has
-- never been set, which is what makes "unset = deny" work.
CREATE OR REPLACE FUNCTION app.current_role_name() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.current_role_name', true), '') $$;

CREATE OR REPLACE FUNCTION app.current_client_id() RETURNS uuid
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text;
BEGIN
  raw := nullif(current_setting('app.current_client_id', true), '');
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN others THEN
  -- A malformed GUC must deny access, not raise an error that a caller could
  -- mistake for "no rows" or, worse, swallow.
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.is_staff() RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(app.current_role_name() IN ('staff', 'admin', 'service'), false) $$;

-- Set by the app once per request/connection checkout. `false` = session scope,
-- which is what a pooled connection needs; call app.reset_context() on release.
CREATE OR REPLACE FUNCTION app.set_context(p_role text, p_client_id uuid)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_role IS NOT NULL AND p_role NOT IN ('client', 'staff', 'admin', 'service') THEN
    RAISE EXCEPTION 'app.set_context: unknown role %', p_role;
  END IF;
  PERFORM set_config('app.current_role_name', coalesce(p_role, ''), false);
  PERFORM set_config('app.current_client_id', coalesce(p_client_id::text, ''), false);
END $$;

CREATE OR REPLACE FUNCTION app.reset_context() RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.current_role_name', '', false);
  PERFORM set_config('app.current_client_id', '', false);
END $$;

-- --------------------------------------------------------------------------
-- The restricted application role
-- --------------------------------------------------------------------------
-- Not a superuser, not the owner of any table, and therefore actually subject
-- to the policies below. Passing NULL/'' for the password leaves the existing
-- password alone (manage it out of band if you prefer).
CREATE OR REPLACE FUNCTION app.ensure_app_role(p_role text, p_password text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_role !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'app.ensure_app_role: invalid role name %', p_role;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    EXECUTE format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', p_role);
    RAISE NOTICE 'rls: created role %', p_role;
  ELSE
    -- Never silently leave a privileged role in place under this name.
    EXECUTE format('ALTER ROLE %I WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', p_role);
  END IF;

  IF p_password IS NOT NULL AND p_password <> '' THEN
    EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', p_role, p_password);
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), p_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', p_role);
  EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO %I', p_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', p_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', p_role);
  -- Future tables created by the current owner are covered without re-running.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', p_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', p_role);

  -- audit_log is append-only (spec §7). Enforce it with grants, not just
  -- convention: the app can write and read history, and cannot rewrite it.
  -- Retention purges therefore need owner-grade credentials (ADMIN_DATABASE_URL).
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM %I', p_role);
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Policies
-- --------------------------------------------------------------------------
DO $$
DECLARE
  rec       record;
  pol_name  text;
  applied   int := 0;
  skipped   int := 0;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      -- table                     client-visibility predicate
      ('clients',                  'id = app.current_client_id()'),
      ('documents',                'client_id = app.current_client_id()'),
      ('threads',                  'client_id = app.current_client_id()'),
      -- messages/tasks carry no client_id; reach it through the parent row.
      ('messages',                 'EXISTS (SELECT 1 FROM public.threads t WHERE t.id = thread_id AND t.client_id = app.current_client_id())'),
      ('tasks',                    'EXISTS (SELECT 1 FROM public.task_lists l WHERE l.id = list_id AND l.client_id = app.current_client_id())'),
      ('invoices',                 'client_id = app.current_client_id()'),
      ('transactions',             'client_id = app.current_client_id()'),
      ('accounts',                 'client_id = app.current_client_id()'),
      -- intake_items.client_id is NULL while a sender is unresolved. NULL never
      -- equals a client uuid, so quarantine stays staff-only. Intended.
      ('intake_items',             'client_id = app.current_client_id()'),
      ('client_questions',         'client_id = app.current_client_id()'),
      ('document_requests',        'client_id = app.current_client_id()'),
      ('anomalies',                'client_id = app.current_client_id()'),
      ('health_scores',            'client_id = app.current_client_id()'),
      ('compliance_events',        'client_id = app.current_client_id()'),
      -- categorization_rules.client_id NULL = firm-wide default: staff only.
      ('categorization_rules',     'client_id = app.current_client_id()'),
      ('work_items',               'client_id = app.current_client_id()'),
      ('close_periods',            'client_id = app.current_client_id()'),
      ('time_entries',             'client_id = app.current_client_id()'),
      ('outbound_messages',        'client_id = app.current_client_id()'),
      ('channel_identities',       'client_id = app.current_client_id()'),
      -- Client-scoped by the same rule; included for consistency.
      ('task_lists',               'client_id = app.current_client_id()'),
      ('signature_requests',       'client_id = app.current_client_id()')
    ) AS v(tbl, predicate)
  LOOP
    IF to_regclass('public.' || quote_ident(rec.tbl)) IS NULL THEN
      RAISE NOTICE 'rls: table public.% does not exist yet — skipped', rec.tbl;
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rec.tbl);

    pol_name := rec.tbl || '_client_scope';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, rec.tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING (app.is_staff() OR (%s)) WITH CHECK (app.is_staff() OR (%s))',
      pol_name, rec.tbl, rec.predicate, rec.predicate);

    applied := applied + 1;
  END LOOP;

  RAISE NOTICE 'rls: policies applied to % table(s), % skipped', applied, skipped;
END $$;

-- --------------------------------------------------------------------------
-- Deliberately NOT under RLS, and why
-- --------------------------------------------------------------------------
--   users, sessions, invites, password_resets — the auth path must read these
--     before any client context exists. Putting them behind a GUC that is only
--     set after login is circular.
--   audit_log — cross-client by design; protected by append-only grants above.
--   leads — pre-client data, staff only at the app layer.
--   categories, extractions, txn_matches, close_checks, precedents, ai_runs,
--     integrations, thread_reads — reached only through a parent row that IS
--     policed, and not exposed on any client-facing route today. Revisit if a
--     client-facing route ever selects from them directly.
