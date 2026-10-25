CREATE TABLE mingocell_data.expert_reviews (
  id uuid PRIMARY KEY,
  analysis_id uuid NOT NULL REFERENCES mingocell_data.classification_jobs(id),
  submission_id uuid NOT NULL REFERENCES mingocell_data.submissions(id),
  revision integer NOT NULL CHECK (revision > 0),
  disposition text NOT NULL CHECK (disposition IN ('Confirmed', 'Reclassified', 'Unresolved')),
  stage text CHECK (stage IN ('MYO', 'PMO', 'MYB', 'MMZ', 'NGB', 'NGS')),
  notes text NOT NULL CHECK (char_length(notes) <= 2000),
  reviewer_id uuid NOT NULL REFERENCES mingocell_auth.users(id),
  reviewer_email text NOT NULL,
  reviewer_role text NOT NULL CHECK (reviewer_role IN ('pathologist', 'admin')),
  request_key uuid NOT NULL,
  payload_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, revision),
  UNIQUE (reviewer_id, request_key),
  CHECK ((disposition = 'Unresolved') = (stage IS NULL))
);

CREATE FUNCTION mingocell_data.reject_review_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Expert reviews are append-only; submit a new decision instead.';
END;
$$;

CREATE TRIGGER expert_reviews_append_only
BEFORE UPDATE OR DELETE ON mingocell_data.expert_reviews
FOR EACH ROW EXECUTE FUNCTION mingocell_data.reject_review_mutation();

CREATE TRIGGER expert_reviews_no_truncate
BEFORE TRUNCATE ON mingocell_data.expert_reviews
FOR EACH STATEMENT EXECUTE FUNCTION mingocell_data.reject_review_mutation();
