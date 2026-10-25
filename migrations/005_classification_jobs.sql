CREATE TABLE mingocell_data.classification_jobs (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE REFERENCES mingocell_data.submissions(id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  attempt_id uuid,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  dispatched_at timestamptz,
  retryable boolean NOT NULL DEFAULT false,
  error_code text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK ((state = 'succeeded') = (result IS NOT NULL)),
  CHECK (state <> 'running' OR (attempt_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX classification_jobs_due_idx ON mingocell_data.classification_jobs(available_at,created_at,id)
  WHERE state = 'queued';
CREATE TABLE mingocell_data.classification_worker (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid,
  heartbeat_at timestamptz,
  state text NOT NULL DEFAULT 'offline' CHECK (state IN ('offline','recovering','ready','suspended')),
  safe_after timestamptz NOT NULL DEFAULT now(),
  error_code text
);
INSERT INTO mingocell_data.classification_worker(singleton) VALUES(true);
