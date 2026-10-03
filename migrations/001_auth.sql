CREATE SCHEMA mingocell_auth;

CREATE TABLE mingocell_auth.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('pathologist', 'maintainer')),
  active boolean NOT NULL DEFAULT true,
  auth_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Layout required by connect-pg-simple. Anonymous sessions bootstrap login CSRF.
CREATE TABLE mingocell_auth.sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX sessions_expire_idx ON mingocell_auth.sessions (expire);
CREATE INDEX sessions_user_idx ON mingocell_auth.sessions ((sess->'auth'->>'userId'));
