CREATE SCHEMA mingocell_data;

CREATE TABLE mingocell_data.images (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES mingocell_auth.users(id),
  original_storage_key text NOT NULL UNIQUE,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  format text NOT NULL CHECK (format IN ('jpeg', 'png', 'tiff')),
  page_count smallint NOT NULL CHECK (page_count BETWEEN 1 AND 20),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX images_owner_uploaded_idx
  ON mingocell_data.images (owner_id, uploaded_at DESC, id DESC);

CREATE TABLE mingocell_data.submissions (
  id uuid PRIMARY KEY,
  image_id uuid NOT NULL REFERENCES mingocell_data.images(id),
  page_index smallint NOT NULL CHECK (page_index BETWEEN 0 AND 19),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  CHECK (width::bigint * height::bigint <= 4000000),
  preview_storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'analyzed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (image_id, page_index)
);

CREATE INDEX submissions_image_idx ON mingocell_data.submissions (image_id, page_index);

CREATE TABLE mingocell_data.upload_idempotency (
  owner_id uuid NOT NULL REFERENCES mingocell_auth.users(id),
  key text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 128),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);
