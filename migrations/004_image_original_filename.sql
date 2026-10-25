ALTER TABLE mingocell_data.images
  ADD COLUMN original_filename text
  CHECK (original_filename IS NULL OR char_length(original_filename) BETWEEN 1 AND 255);
