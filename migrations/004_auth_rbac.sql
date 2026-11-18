-- 004: Authentication, departments, role-based access control, sessions, settings.
-- Purpose: adds user accounts with hashed passwords, configurable roles and
-- permissions, server-side sessions, departments, and system settings.
-- Safety: additive only. No existing table or record is changed or removed.
-- Supersedes the review-only proposal in migrations/proposals/004_auth_rbac.sql
-- (same tables and keys, plus department/session/settings support).
-- Rollback (only if no users have been created yet):
--   DROP TABLE settings, user_sessions, role_permissions, user_roles, permissions, roles, users, departments;
--   DELETE FROM schema_migrations WHERE migration = '004_auth_rbac.sql';

CREATE TABLE IF NOT EXISTS departments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_code (code),
  UNIQUE KEY uq_departments_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  department_id INT UNSIGNED NULL,
  status ENUM('Active', 'Inactive', 'Locked') NOT NULL DEFAULT 'Active',
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  failed_login_count INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_status_name (status, full_name),
  KEY idx_users_department (department_id),
  CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_key VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_key (role_key),
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  permission_key VARCHAR(100) NOT NULL,
  name VARCHAR(150) NOT NULL,
  module VARCHAR(60) NOT NULL,
  description VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_key (permission_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  assigned_by BIGINT UNSIGNED NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_id),
  KEY idx_user_roles_role (role_id),
  KEY idx_user_roles_assigned_by (assigned_by),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_user_roles_assigned_by FOREIGN KEY (assigned_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id),
  KEY idx_role_permissions_permission (permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_sessions (
  id CHAR(64) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  flash TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_user_sessions_user (user_id),
  KEY idx_user_sessions_expires (expires_at),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(100) NOT NULL,
  setting_value VARCHAR(255) NOT NULL,
  label VARCHAR(150) NOT NULL,
  description VARCHAR(500) NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO departments (code, name) VALUES
  ('ADMIN', 'Administration'),
  ('PROC', 'Procurement'),
  ('OPS', 'Operations'),
  ('WH', 'Warehouse'),
  ('FIN', 'Finance')
ON DUPLICATE KEY UPDATE code = VALUES(code);

INSERT INTO roles (role_key, name, description, is_system) VALUES
  ('super_admin', 'Super Admin', 'Full system administration access.', 1),
  ('procurement_officer', 'Procurement Officer', 'Manages suppliers and purchasing workflows.', 0),
  ('purchasing_manager', 'Purchasing Manager', 'Reviews and approves procurement requests and orders.', 0),
  ('warehouse_staff', 'Warehouse / Inventory Staff', 'Records deliveries and manages inventory.', 0),
  ('finance_officer', 'Finance Officer', 'Monitors budgets and financial reports.', 0),
  ('department_requester', 'Department Requester', 'Creates and tracks department purchase requests.', 0)
ON DUPLICATE KEY UPDATE description = VALUES(description);

INSERT INTO permissions (permission_key, name, module, description) VALUES
  ('dashboard.view', 'View Dashboard', 'Dashboard', 'View procurement overview and dashboard information.'),
  ('suppliers.view', 'View Suppliers', 'Suppliers', 'View supplier records.'),
  ('suppliers.manage', 'Manage Suppliers', 'Suppliers', 'Create, update, deactivate, and delete unused suppliers.'),
  ('products.view', 'View Products', 'Products', 'View product and category records.'),
  ('products.manage', 'Manage Products', 'Products', 'Create, update, and delete products and categories.'),
  ('inventory.view', 'View Inventory', 'Inventory', 'View stock levels and inventory history.'),
  ('inventory.manage', 'Manage Inventory', 'Inventory', 'Record stock received and authorized stock adjustments.'),
  ('requisitions.view_all', 'View All Requisitions', 'Requisitions', 'View requisitions across departments.'),
  ('requisitions.create', 'Create Requisitions', 'Requisitions', 'Create and submit purchase requisitions.'),
  ('requisitions.approve', 'Approve Requisitions', 'Approvals', 'Approve, reject, or return submitted requisitions.'),
  ('purchase_orders.view', 'View Purchase Orders', 'Purchase Orders', 'View purchase orders and their history.'),
  ('purchase_orders.manage', 'Manage Purchase Orders', 'Purchase Orders', 'Create and update eligible purchase orders.'),
  ('purchase_orders.approve', 'Approve Purchase Orders', 'Approvals', 'Approve, return, or reject purchase orders.'),
  ('deliveries.view', 'View Deliveries', 'Deliveries', 'View delivery and receiving records.'),
  ('deliveries.manage', 'Manage Deliveries', 'Deliveries', 'Record and confirm incoming deliveries.'),
  ('budgets.view', 'View Budgets', 'Budgets', 'View budget allocation and utilization.'),
  ('budgets.manage', 'Manage Budgets', 'Budgets', 'Create and update procurement budgets.'),
  ('reports.view', 'View Reports', 'Reports', 'View procurement reports and analytics.'),
  ('reports.export', 'Export Reports', 'Reports', 'Export reports to CSV (Excel) and print/PDF.'),
  ('notifications.view', 'View Notifications', 'Notifications', 'View and manage personal notifications.'),
  ('activity_logs.view', 'View Activity Logs', 'Activity Logs', 'View read-only system activity records.'),
  ('users.manage', 'Manage Users', 'Administration', 'Create, update, activate, and deactivate user accounts.'),
  ('roles.manage', 'Manage Roles', 'Administration', 'Create roles and assign permissions.'),
  ('settings.manage', 'Manage Settings', 'Administration', 'Manage departments and system-wide configuration.')
ON DUPLICATE KEY UPDATE name = VALUES(name), module = VALUES(module), description = VALUES(description);

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.role_key = 'super_admin';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN (
  'dashboard.view', 'suppliers.view', 'suppliers.manage', 'products.view', 'products.manage',
  'inventory.view', 'requisitions.view_all', 'requisitions.create', 'purchase_orders.view',
  'purchase_orders.manage', 'deliveries.view', 'budgets.view', 'reports.view', 'reports.export',
  'notifications.view')
WHERE r.role_key = 'procurement_officer';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN (
  'dashboard.view', 'suppliers.view', 'products.view', 'inventory.view', 'requisitions.view_all',
  'requisitions.approve', 'purchase_orders.view', 'purchase_orders.approve', 'deliveries.view',
  'budgets.view', 'reports.view', 'reports.export', 'notifications.view', 'activity_logs.view')
WHERE r.role_key = 'purchasing_manager';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN (
  'dashboard.view', 'suppliers.view', 'products.view', 'inventory.view', 'inventory.manage',
  'requisitions.create', 'purchase_orders.view', 'deliveries.view', 'deliveries.manage',
  'notifications.view')
WHERE r.role_key = 'warehouse_staff';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN (
  'dashboard.view', 'suppliers.view', 'purchase_orders.view', 'deliveries.view', 'budgets.view',
  'budgets.manage', 'reports.view', 'reports.export', 'notifications.view')
WHERE r.role_key = 'finance_officer';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN (
  'dashboard.view', 'products.view', 'requisitions.create', 'notifications.view')
WHERE r.role_key = 'department_requester';

INSERT INTO settings (setting_key, setting_value, label, description) VALUES
  ('organization_name', 'Mindoro Tech Hardware & BuildSupply Corp.', 'Organization name', 'Shown on printed purchase orders and reports.'),
  ('requisition_approval_levels', '1', 'Requisition approval levels', 'Number of distinct approvers (1-3) required before a requisition is approved.'),
  ('po_approval_levels', '1', 'Purchase order approval levels', 'Number of distinct approvers (1-3) required before a purchase order is approved.'),
  ('allow_self_approval', '0', 'Allow self-approval', 'When 1, approvers may approve requests they created themselves.'),
  ('default_tax_rate', '12', 'Default tax rate (%)', 'Pre-filled tax rate for new purchase orders.'),
  ('budget_warning_threshold', '80', 'Default budget warning threshold (%)', 'Default utilization percentage that triggers budget warnings.'),
  ('budget_overrun_policy', 'block', 'Budget overrun policy', 'block = purchase orders exceeding the remaining budget cannot be approved; warn = approve and notify.'),
  ('upcoming_delivery_days', '7', 'Upcoming delivery window (days)', 'Deliveries due within this many days appear as upcoming.'),
  ('session_idle_minutes', '30', 'Session idle timeout (minutes)', 'Signed-in sessions expire after this many idle minutes.')
ON DUPLICATE KEY UPDATE label = VALUES(label), description = VALUES(description);
