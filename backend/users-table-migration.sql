-- Run in the Supabase SQL Editor before restarting the LMS after moving user
-- records out of lms_state. The backend will import legacy users automatically.
BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.users FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO service_role;

COMMIT;
