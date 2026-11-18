-- BuildSync proposal: authentication and role-based access control foundation.
-- SUPERSEDED: this proposal is implemented by migrations/004_auth_rbac.sql (same tables/keys plus
-- departments, sessions, and settings). Kept for history; do not run it separately.
-- Review-only script; the application migration runner does not execute this file.
-- Target: the existing MySQL 8 database. This script only adds new tables and
-- baseline lookup records; it does not alter or delete suppliers or orders.
--
-- Before an approved execution:
-- 1. Export a full database backup in phpMyAdmin (include structure and data).
-- 2. Verify the backup can be restored to a separate database.
-- 3. Run this script in a maintenance window, then verify all five tables and
--    the seeded role/permission counts before deploying authentication code.
--
-- MySQL DDL implicitly commits, so this is not transactionally reversible.
-- Do not drop these tables as a rollback if users or assignments have been
-- created. If rollback is necessary after use, restore the pre-migration backup
-- only when no post-backup writes need preserving; otherwise plan a data-aware
-- reverse migration.

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  status ENUM('Active', 'Inactive', 'Locked') NOT NULL DEFAULT 'Inactive',
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_status_name (status, full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_key VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_key (role_key),
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  permission_key VARCHAR(100) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_key (permission_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  assigned_by BIGINT UNSIGNED NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_id),
  KEY idx_user_roles_role (role_id),
  KEY idx_user_roles_assigned_by (assigned_by),
  CONSTRAINT fk_user_roles_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_role
    FOREIGN KEY (role_id) REFERENCES roles (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_user_roles_assigned_by
    FOREIGN KEY (assigned_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id),
  KEY idx_role_permissions_permission (permission_id),
  CONSTRAINT fk_role_permissions_role
    FOREIGN KEY (role_id) REFERENCES roles (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission
    FOREIGN KEY (permission_id) REFERENCES permissions (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO roles (role_key, name, description) VALUES
  ('super_admin', 'Super Admin', 'Full system administration access.'),
  ('procurement_officer', 'Procurement Officer', 'Manages suppliers and purchasing workflows.'),
  ('purchasing_manager', 'Purchasing Manager', 'Reviews and approves procurement requests and orders.'),
  ('warehouse_staff', 'Warehouse / Inventory Staff', 'Records deliveries and manages inventory.'),
  ('finance_officer', 'Finance Officer', 'Monitors budgets and financial reports.'),
  ('department_requester', 'Department Requester', 'Creates and tracks department purchase requests.')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description);

INSERT INTO permissions (permission_key, name, description) VALUES
  ('dashboard.view', 'View Dashboard', 'View procurement overview and dashboard information.'),
  ('suppliers.view', 'View Suppliers', 'View supplier records.'),
  ('suppliers.manage', 'Manage Suppliers', 'Create and update supplier records.'),
  ('products.view', 'View Products', 'View product and category records.'),
  ('products.manage', 'Manage Products', 'Create, update, and deactivate products and categories.'),
  ('inventory.view', 'View Inventory', 'View stock levels and inventory history.'),
  ('inventory.manage', 'Manage Inventory', 'Receive stock and record authorized stock adjustments.'),
  ('requisitions.view_all', 'View All Requisitions', 'View requisitions across departments.'),
  ('requisitions.create', 'Create Requisitions', 'Create and submit purchase requisitions.'),
  ('requisitions.approve', 'Approve Requisitions', 'Approve, reject, or return submitted requisitions.'),
  ('purchase_orders.view', 'View Purchase Orders', 'View purchase orders and their history.'),
  ('purchase_orders.manage', 'Manage Purchase Orders', 'Create and update eligible purchase orders.'),
  ('purchase_orders.approve', 'Approve Purchase Orders', 'Approve or cancel purchase orders.'),
  ('deliveries.view', 'View Deliveries', 'View delivery and receiving records.'),
  ('deliveries.manage', 'Manage Deliveries', 'Record and confirm incoming deliveries.'),
  ('budgets.view', 'View Budgets', 'View budget allocation and utilization.'),
  ('budgets.manage', 'Manage Budgets', 'Create and update procurement budgets.'),
  ('reports.view', 'View Reports', 'View procurement reports and analytics.'),
  ('reports.export', 'Export Reports', 'Export authorized reports.'),
  ('notifications.view', 'View Notifications', 'View and manage personal notifications.'),
  ('activity_logs.view', 'View Activity Logs', 'View immutable system activity records.'),
  ('users.manage', 'Manage Users', 'Create, update, activate, and deactivate user accounts.'),
  ('roles.manage', 'Manage Roles', 'Create roles and assign permissions.'),
  ('settings.manage', 'Manage Settings', 'Manage system-wide configuration.')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description);

-- No user accounts or role assignments are created here. Initial privileged
-- accounts must be provisioned through a reviewed, password-hashing workflow.
