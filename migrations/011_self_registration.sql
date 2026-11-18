-- 011: Self-service account registration.
-- Adds a 'Pending' account status (registered, awaiting administrator approval) and the
-- settings that control registration. Safety: additive; existing users keep their status.
-- Rollback (only if no user is Pending):
--   ALTER TABLE users MODIFY COLUMN status ENUM('Active', 'Inactive', 'Locked') NOT NULL DEFAULT 'Active';
--   DELETE FROM settings WHERE setting_key IN ('self_registration', 'self_registration_role');
--   DELETE FROM schema_migrations WHERE migration = '011_self_registration.sql';

ALTER TABLE users
  MODIFY COLUMN status ENUM('Active', 'Inactive', 'Locked', 'Pending') NOT NULL DEFAULT 'Active';

INSERT INTO settings (setting_key, setting_value, label, description) VALUES
  ('self_registration', 'approval', 'Self-registration', 'approval = new accounts wait for an administrator; open = new accounts can sign in immediately; disabled = only administrators create accounts.'),
  ('self_registration_role', 'department_requester', 'Role for self-registered users', 'Role key assigned to accounts created from the sign-in page. Use a least-privileged role.')
ON DUPLICATE KEY UPDATE label = VALUES(label), description = VALUES(description);
