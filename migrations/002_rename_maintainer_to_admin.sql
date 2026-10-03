ALTER TABLE mingocell_auth.users DROP CONSTRAINT users_role_check;
UPDATE mingocell_auth.users SET role = 'admin' WHERE role = 'maintainer';
ALTER TABLE mingocell_auth.users
  ADD CONSTRAINT users_role_check CHECK (role IN ('pathologist', 'admin'));
