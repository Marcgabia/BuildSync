-- 005: Activity logs (append-only audit trail) and the notification center.
-- Safety: additive only.
-- The application never updates or deletes activity_logs. For defense in depth,
-- grant the application's MySQL user only SELECT and INSERT on activity_logs.
-- Rollback: DROP TABLE notifications, activity_logs;
--           DELETE FROM schema_migrations WHERE migration = '005_activity_notifications.sql';

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NULL,
  action VARCHAR(60) NOT NULL,
  module VARCHAR(60) NOT NULL,
  record_id VARCHAR(64) NULL,
  description VARCHAR(1000) NOT NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_activity_logs_module_created (module, created_at),
  KEY idx_activity_logs_user_created (user_id, created_at),
  KEY idx_activity_logs_created (created_at),
  CONSTRAINT fk_activity_logs_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  link VARCHAR(255) NULL,
  reference_type VARCHAR(40) NULL,
  reference_id BIGINT UNSIGNED NULL,
  dedupe_key VARCHAR(150) NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notifications_user_dedupe (user_id, dedupe_key),
  KEY idx_notifications_user_read (user_id, is_read, created_at),
  KEY idx_notifications_type (type),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;
