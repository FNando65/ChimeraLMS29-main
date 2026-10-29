-- Chimera LMS PostgreSQL target schema.
-- IDs are TEXT so existing JSON IDs (for example u1 and cert-data-science)
-- can be migrated without rewriting references. New IDs may be UUID strings.

BEGIN;

-- Compatibility persistence used by server.js during the first Supabase rollout.
-- The application payload is JSONB; normalized tables below define the target
-- model for the later table-by-table migration.
CREATE TABLE IF NOT EXISTS lms_state (
  id TEXT PRIMARY KEY CHECK (id = 'main'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE lms_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE lms_state FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE lms_state TO service_role;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('learner', 'lecturer', 'admin')),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive', 'Pending')),
  avatar TEXT,
  profile_image TEXT,
  identity_number TEXT,
  passport_number TEXT,
  date_of_birth DATE,
  gender TEXT,
  phone TEXT,
  last_school TEXT,
  password_salt TEXT,
  password_hash TEXT,
  recovery_question TEXT,
  recovery_answer_hash TEXT,
  last_login_at TIMESTAMPTZ,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized CHECK (email = lower(email))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_identity_unique ON users (identity_number) WHERE identity_number IS NOT NULL AND identity_number <> '';
CREATE UNIQUE INDEX IF NOT EXISTS users_passport_unique ON users (passport_number) WHERE passport_number IS NOT NULL AND passport_number <> '';
CREATE INDEX IF NOT EXISTS users_role_status_idx ON users (role, status);
ALTER TABLE users ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE users FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users TO service_role;

CREATE TABLE IF NOT EXISTS faculties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  faculty_id TEXT REFERENCES faculties(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  UNIQUE (faculty_id, name)
);

CREATE TABLE IF NOT EXISTS programmes (
  id TEXT PRIMARY KEY,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive', 'Archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS academic_terms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_on DATE,
  ends_on DATE,
  registration_closes_on DATE,
  status TEXT NOT NULL DEFAULT 'Planned' CHECK (status IN ('Planned', 'Current', 'Completed', 'Archived')),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY,
  programme_id TEXT REFERENCES programmes(id) ON DELETE SET NULL,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  term_id TEXT REFERENCES academic_terms(id) ON DELETE SET NULL,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'archived')),
  submitted_for_approval_at TIMESTAMPTZ,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejected_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS courses_instructor_status_idx ON courses (instructor_id, status);
CREATE INDEX IF NOT EXISTS courses_programme_status_idx ON courses (programme_id, status);

CREATE TABLE IF NOT EXISTS course_staff (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_role TEXT NOT NULL DEFAULT 'lecturer' CHECK (staff_role IN ('lecturer', 'assistant')),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, user_id)
);

CREATE TABLE IF NOT EXISTS course_approval_events (
  id BIGSERIAL PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('submitted', 'approved', 'rejected', 'reopened')),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_modules (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, group_name, position)
);
CREATE INDEX IF NOT EXISTS course_modules_order_idx ON course_modules (course_id, group_name, position);

CREATE TABLE IF NOT EXISTS enrollments (
  learner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'completed', 'suspended')),
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  managed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (learner_id, course_id)
);
CREATE INDEX IF NOT EXISTS enrollments_course_status_idx ON enrollments (course_id, status);

CREATE TABLE IF NOT EXISTS programme_applications (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  programme_id TEXT REFERENCES programmes(id) ON DELETE SET NULL,
  requested_course_title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS applications_status_date_idx ON programme_applications (status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS module_progress (
  learner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (learner_id, module_id)
);

CREATE TABLE IF NOT EXISTS module_notes (
  learner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (learner_id, module_id)
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('Assignment', 'Practical', 'Quiz')),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  due_at TIMESTAMPTZ,
  max_score NUMERIC(7,2) NOT NULL DEFAULT 100 CHECK (max_score > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assessments_course_due_idx ON assessments (course_id, due_at);

CREATE TABLE IF NOT EXISTS assessment_questions (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  points NUMERIC(7,2) NOT NULL DEFAULT 1 CHECK (points > 0),
  UNIQUE (assessment_id, position)
);

CREATE TABLE IF NOT EXISTS assessment_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES assessment_questions(id) ON DELETE CASCADE,
  option_text TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  is_correct BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (question_id, position),
  UNIQUE (question_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_correct_option_per_question ON assessment_options (question_id) WHERE is_correct;

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  learner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  comments TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  file_type TEXT,
  file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  storage_key TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  score NUMERIC(7,2) CHECK (score IS NULL OR score >= 0),
  feedback TEXT NOT NULL DEFAULT '',
  graded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  graded_at TIMESTAMPTZ,
  UNIQUE (assessment_id, learner_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS submissions_grading_queue_idx ON submissions (assessment_id, graded_at, submitted_at);
CREATE INDEX IF NOT EXISTS submissions_learner_idx ON submissions (learner_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS submission_answers (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES assessment_questions(id) ON DELETE CASCADE,
  selected_option_id TEXT,
  answer_text TEXT,
  PRIMARY KEY (submission_id, question_id),
  FOREIGN KEY (question_id, selected_option_id) REFERENCES assessment_options(question_id, id)
);

CREATE TABLE IF NOT EXISTS course_materials (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  storage_key TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attendance_records (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  learner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent')),
  marked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, learner_id, attendance_date)
);
CREATE INDEX IF NOT EXISTS attendance_learner_date_idx ON attendance_records (learner_id, attendance_date DESC);

CREATE TABLE IF NOT EXISTS course_messages (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS messages_inbox_idx ON course_messages (recipient_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON course_messages (sender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'learner', 'lecturer')),
  scope TEXT NOT NULL CHECK (scope IN ('system', 'course')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'system' AND course_id IS NULL) OR (scope = 'course' AND course_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS announcements_course_date_idx ON announcements (course_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  notification_type TEXT NOT NULL DEFAULT 'update',
  entity_type TEXT,
  entity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL CHECK (actor_role IN ('learner', 'lecturer', 'admin', 'system')),
  action TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'Success',
  entity_type TEXT,
  entity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_role_date_idx ON activity_log (actor_role, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_actor_date_idx ON activity_log (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS user_sessions_active_idx ON user_sessions (user_id, expires_at) WHERE revoked_at IS NULL;

-- Read models used by the learner catalogue and lecturer/admin progress views.
CREATE OR REPLACE VIEW course_enrollment_counts AS
SELECT c.id AS course_id,
       COUNT(e.learner_id) FILTER (WHERE e.status = 'active') AS active_learners
FROM courses c
LEFT JOIN enrollments e ON e.course_id = c.id
GROUP BY c.id;

CREATE OR REPLACE VIEW learner_course_progress AS
SELECT e.learner_id,
       e.course_id,
       COUNT(DISTINCT m.id) AS total_modules,
       COUNT(DISTINCT mp.module_id) AS completed_modules,
       CASE WHEN COUNT(DISTINCT m.id) = 0 THEN 0
            ELSE ROUND(100.0 * COUNT(DISTINCT mp.module_id) / COUNT(DISTINCT m.id))::INTEGER
       END AS progress_percent
FROM enrollments e
LEFT JOIN course_modules m ON m.course_id = e.course_id
LEFT JOIN module_progress mp ON mp.module_id = m.id AND mp.learner_id = e.learner_id
WHERE e.status = 'active'
GROUP BY e.learner_id, e.course_id;

COMMIT;
