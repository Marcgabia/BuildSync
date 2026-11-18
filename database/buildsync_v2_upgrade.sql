-- BuildSync v2 upgrade — combined script for phpMyAdmin (Import tab) or the mysql CLI.
-- Generated from migrations/004-010 (the same files the app runs automatically on start).
-- 1. Back up buildsync_db first (phpMyAdmin > Export > Custom > structure + data).
-- 2. Select the buildsync_db database, then import this file ONCE.
-- 3. The final INSERT marks these migrations as applied so the app will not run them again.
-- Do not import if the app has already applied them (check: SELECT * FROM schema_migrations).

-- ===================== 004_auth_rbac.sql =====================
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

-- ===================== 005_activity_notifications.sql =====================
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

-- ===================== 006_products_inventory.sql =====================
-- 006: Product categories, products, inventory movement history, supplier extensions.
-- Safety: additive. Two nullable columns are added to suppliers; existing supplier
-- rows keep all their values. CHECK constraints prevent negative stock.
-- Rollback: DROP TABLE inventory_transactions, products, categories;
--           ALTER TABLE suppliers DROP COLUMN tax_id, DROP COLUMN reliability_rating;
--           DELETE FROM schema_migrations WHERE migration = '006_products_inventory.sql';

ALTER TABLE suppliers
  ADD COLUMN tax_id VARCHAR(50) NULL AFTER email,
  ADD COLUMN reliability_rating TINYINT UNSIGNED NULL AFTER delivery_lead_time,
  ADD KEY idx_suppliers_status (status);

CREATE TABLE IF NOT EXISTS categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_code VARCHAR(60) NOT NULL,
  name VARCHAR(200) NOT NULL,
  category_id INT UNSIGNED NOT NULL,
  description TEXT NULL,
  unit VARCHAR(30) NOT NULL,
  supplier_id INT NULL,
  unit_price DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  current_stock INT NOT NULL DEFAULT 0,
  minimum_stock INT NOT NULL DEFAULT 0,
  status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_code (product_code),
  KEY idx_products_category (category_id),
  KEY idx_products_supplier (supplier_id),
  KEY idx_products_status_name (status, name),
  CONSTRAINT chk_products_stock CHECK (current_stock >= 0),
  CONSTRAINT chk_products_minimum CHECK (minimum_stock >= 0),
  CONSTRAINT chk_products_price CHECK (unit_price >= 0),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_products_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_products_created_by FOREIGN KEY (created_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT UNSIGNED NOT NULL,
  transaction_type ENUM('Opening', 'Receipt', 'Adjustment In', 'Adjustment Out') NOT NULL,
  quantity INT NOT NULL,
  balance_after INT NOT NULL,
  reference_type VARCHAR(40) NULL,
  reference_id BIGINT UNSIGNED NULL,
  notes VARCHAR(500) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_reference (reference_type, reference_id),
  KEY idx_inventory_product_created (product_id, created_at),
  KEY idx_inventory_created (created_at),
  CONSTRAINT chk_inventory_balance CHECK (balance_after >= 0),
  CONSTRAINT fk_inventory_product FOREIGN KEY (product_id) REFERENCES products (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_created_by FOREIGN KEY (created_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

-- ===================== 007_requisitions_approvals.sql =====================
-- 007: Purchase requisitions, requisition items, and the approval decision history.
-- Safety: additive only.
-- Rollback: DROP TABLE approvals, requisition_items, purchase_requisitions;
--           DELETE FROM schema_migrations WHERE migration = '007_requisitions_approvals.sql';

CREATE TABLE IF NOT EXISTS purchase_requisitions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  requisition_number VARCHAR(30) NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  department_id INT UNSIGNED NOT NULL,
  request_date DATE NOT NULL,
  required_date DATE NOT NULL,
  purpose TEXT NOT NULL,
  total_estimated DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  status ENUM('Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected',
    'Returned for Revision', 'Converted to Purchase Order', 'Cancelled') NOT NULL DEFAULT 'Draft',
  current_approval_level TINYINT UNSIGNED NOT NULL DEFAULT 0,
  submitted_at DATETIME NULL,
  decided_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_requisitions_number (requisition_number),
  KEY idx_requisitions_status (status),
  KEY idx_requisitions_requested_by (requested_by),
  KEY idx_requisitions_department (department_id),
  CONSTRAINT fk_requisitions_requested_by FOREIGN KEY (requested_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_requisitions_department FOREIGN KEY (department_id) REFERENCES departments (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS requisition_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  requisition_id INT UNSIGNED NOT NULL,
  line_no SMALLINT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  description VARCHAR(500) NULL,
  quantity INT NOT NULL,
  estimated_unit_price DECIMAL(12, 2) NOT NULL,
  subtotal DECIMAL(14, 2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_requisition_items_line (requisition_id, line_no),
  KEY idx_requisition_items_product (product_id),
  CONSTRAINT chk_requisition_items_quantity CHECK (quantity > 0),
  CONSTRAINT chk_requisition_items_price CHECK (estimated_unit_price >= 0),
  CONSTRAINT fk_requisition_items_requisition FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_requisition_items_product FOREIGN KEY (product_id) REFERENCES products (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS approvals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference_type ENUM('requisition', 'purchase_order') NOT NULL,
  reference_id BIGINT UNSIGNED NOT NULL,
  approval_level TINYINT UNSIGNED NOT NULL DEFAULT 1,
  approver_id BIGINT UNSIGNED NOT NULL,
  status ENUM('Approved', 'Rejected', 'Returned') NOT NULL,
  comments TEXT NULL,
  approved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_approvals_reference (reference_type, reference_id),
  KEY idx_approvals_approver (approver_id),
  CONSTRAINT fk_approvals_approver FOREIGN KEY (approver_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ===================== 008_purchase_order_items.sql =====================
-- 008: Multi-item purchase orders, requisition linkage, discounts, taxes, workflow fields.
-- Existing purchase orders are preserved:
--   * Legacy single-item columns (item_sku, description, quantity_ordered, unit_cost) are kept
--     but become optional, because new orders store their lines in purchase_order_items.
--   * Every existing order is copied into purchase_order_items as one line.
--   * subtotal is set to the existing total_cost and order_date to the creation date.
--   * The legacy status 'Received' is renamed to 'Completed' (the status used by the new
--     workflow). Reverse with: UPDATE purchase_orders SET status = 'Received' WHERE status = 'Completed';
-- active_requisition_id (= requisition_id unless the order is Cancelled) is UNIQUE, so an approved
-- requisition can only have one live purchase order. Cancelled orders free the requisition again.
-- Rollback: restore the pre-upgrade backup (backups/buildsync_db_pre_upgrade_*.sql) if no new
-- orders were created; otherwise drop purchase_order_items and the added columns manually.

ALTER TABLE purchase_orders
  MODIFY COLUMN item_sku VARCHAR(100) NULL,
  MODIFY COLUMN description TEXT NULL,
  MODIFY COLUMN quantity_ordered INT NULL,
  MODIFY COLUMN unit_cost DECIMAL(10, 2) NULL,
  MODIFY COLUMN total_cost DECIMAL(14, 2) NOT NULL,
  ADD COLUMN requisition_id INT UNSIGNED NULL AFTER supplier_id,
  ADD COLUMN department_id INT UNSIGNED NULL AFTER requisition_id,
  ADD COLUMN created_by BIGINT UNSIGNED NULL AFTER department_id,
  ADD COLUMN order_date DATE NULL AFTER created_by,
  ADD COLUMN subtotal DECIMAL(14, 2) NOT NULL DEFAULT 0.00 AFTER unit_cost,
  ADD COLUMN discount_amount DECIMAL(14, 2) NOT NULL DEFAULT 0.00 AFTER subtotal,
  ADD COLUMN tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 0.00 AFTER discount_amount,
  ADD COLUMN tax_amount DECIMAL(14, 2) NOT NULL DEFAULT 0.00 AFTER tax_rate,
  ADD COLUMN notes TEXT NULL AFTER target_date,
  ADD COLUMN current_approval_level TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER notes,
  ADD COLUMN submitted_at DATETIME NULL AFTER current_approval_level,
  ADD COLUMN approved_by BIGINT UNSIGNED NULL AFTER submitted_at,
  ADD COLUMN approved_at DATETIME NULL AFTER approved_by,
  ADD COLUMN ordered_at DATETIME NULL AFTER approved_at,
  ADD COLUMN completed_at DATETIME NULL AFTER ordered_at,
  ADD COLUMN cancelled_at DATETIME NULL AFTER completed_at,
  ADD COLUMN cancel_reason VARCHAR(500) NULL AFTER cancelled_at,
  ADD KEY idx_purchase_orders_requisition (requisition_id),
  ADD KEY idx_purchase_orders_status (status),
  ADD KEY idx_purchase_orders_target_date (target_date),
  ADD CONSTRAINT fk_purchase_orders_requisition FOREIGN KEY (requisition_id)
    REFERENCES purchase_requisitions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purchase_orders_department FOREIGN KEY (department_id)
    REFERENCES departments (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT fk_purchase_orders_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON UPDATE CASCADE ON DELETE SET NULL,
  ADD CONSTRAINT fk_purchase_orders_approved_by FOREIGN KEY (approved_by)
    REFERENCES users (id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE purchase_orders
  ADD COLUMN active_requisition_id INT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status <> 'Cancelled' THEN requisition_id END) STORED,
  ADD UNIQUE KEY uq_purchase_orders_active_requisition (active_requisition_id);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_order_id INT NOT NULL,
  line_no SMALLINT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NULL,
  item_code VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  line_total DECIMAL(14, 2) NOT NULL,
  received_quantity INT NOT NULL DEFAULT 0,
  damaged_quantity INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_order_items_line (purchase_order_id, line_no),
  KEY idx_purchase_order_items_product (product_id),
  CONSTRAINT chk_po_items_quantity CHECK (quantity > 0),
  CONSTRAINT chk_po_items_price CHECK (unit_price >= 0),
  CONSTRAINT chk_po_items_received CHECK (received_quantity >= 0 AND received_quantity <= quantity),
  CONSTRAINT chk_po_items_damaged CHECK (damaged_quantity >= 0),
  CONSTRAINT fk_po_items_order FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_po_items_product FOREIGN KEY (product_id) REFERENCES products (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

UPDATE purchase_orders SET status = 'Completed' WHERE status = 'Received';

UPDATE purchase_orders
SET subtotal = total_cost,
    order_date = DATE(created_at)
WHERE subtotal = 0 AND order_date IS NULL;

INSERT INTO purchase_order_items
  (purchase_order_id, line_no, item_code, description, quantity, unit_price, line_total, received_quantity)
SELECT po.id, 1, COALESCE(po.item_sku, 'LEGACY'), COALESCE(po.description, ''), GREATEST(COALESCE(po.quantity_ordered, 1), 1),
       COALESCE(po.unit_cost, 0), po.total_cost,
       CASE WHEN po.status = 'Completed' THEN GREATEST(COALESCE(po.quantity_ordered, 1), 1) ELSE 0 END
FROM purchase_orders po
WHERE NOT EXISTS (SELECT 1 FROM purchase_order_items i WHERE i.purchase_order_id = po.id);

-- ===================== 009_deliveries.sql =====================
-- 009: Deliveries & receiving, delivery line items, and delivery receipt attachments.
-- Safety: additive only. Uploaded files are stored outside the public web folder.
-- Rollback: DROP TABLE delivery_attachments, delivery_items, deliveries;
--           DELETE FROM schema_migrations WHERE migration = '009_deliveries.sql';

CREATE TABLE IF NOT EXISTS deliveries (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_number VARCHAR(30) NOT NULL,
  purchase_order_id INT NOT NULL,
  supplier_id INT NOT NULL,
  reference_number VARCHAR(100) NULL,
  expected_date DATE NULL,
  delivery_date DATE NULL,
  received_by BIGINT UNSIGNED NULL,
  status ENUM('Pending', 'In Transit', 'Partially Received', 'Fully Received', 'Delayed', 'Rejected')
    NOT NULL DEFAULT 'Pending',
  remarks TEXT NULL,
  confirmed_at DATETIME NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deliveries_number (delivery_number),
  UNIQUE KEY uq_deliveries_supplier_reference (supplier_id, reference_number),
  KEY idx_deliveries_po (purchase_order_id),
  KEY idx_deliveries_status (status),
  KEY idx_deliveries_expected (expected_date),
  CONSTRAINT fk_deliveries_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_deliveries_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_deliveries_received_by FOREIGN KEY (received_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_deliveries_created_by FOREIGN KEY (created_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS delivery_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id INT UNSIGNED NOT NULL,
  purchase_order_item_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NULL,
  ordered_quantity INT NOT NULL,
  previously_received INT NOT NULL DEFAULT 0,
  received_quantity INT NOT NULL,
  damaged_quantity INT NOT NULL DEFAULT 0,
  accepted_quantity INT NOT NULL,
  remarks VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_items_line (delivery_id, purchase_order_item_id),
  KEY idx_delivery_items_po_item (purchase_order_item_id),
  CONSTRAINT chk_delivery_items_quantities CHECK (
    received_quantity >= 0 AND damaged_quantity >= 0 AND damaged_quantity <= received_quantity
    AND accepted_quantity = received_quantity - damaged_quantity),
  CONSTRAINT fk_delivery_items_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_delivery_items_po_item FOREIGN KEY (purchase_order_item_id) REFERENCES purchase_order_items (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_delivery_items_product FOREIGN KEY (product_id) REFERENCES products (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS delivery_attachments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id INT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(100) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  uploaded_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_attachments_stored (stored_name),
  KEY idx_delivery_attachments_delivery (delivery_id),
  CONSTRAINT fk_delivery_attachments_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_delivery_attachments_user FOREIGN KEY (uploaded_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

-- ===================== 010_budgets.sql =====================
-- 010: Procurement budgets and the budget ledger (commitments, releases, actual spending).
-- Committed amount = SUM(Commitment + Commitment Release) and actual spending = SUM(Actual)
-- are derived from budget_transactions, so balances can never drift from their history.
-- dedupe_key makes each ledger posting idempotent (e.g. one commitment per order).
-- Annual budgets use period_month = 0 so the unique period key is enforced.
-- Rollback: ALTER TABLE purchase_orders DROP FOREIGN KEY fk_purchase_orders_budget, DROP COLUMN budget_id;
--           DROP TABLE budget_transactions, budgets;
--           DELETE FROM schema_migrations WHERE migration = '010_budgets.sql';

CREATE TABLE IF NOT EXISTS budgets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  department_id INT UNSIGNED NOT NULL,
  period_type ENUM('Annual', 'Monthly') NOT NULL,
  fiscal_year SMALLINT UNSIGNED NOT NULL,
  period_month TINYINT UNSIGNED NOT NULL DEFAULT 0,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  allocated_amount DECIMAL(14, 2) NOT NULL,
  warning_threshold DECIMAL(5, 2) NOT NULL DEFAULT 80.00,
  status ENUM('Active', 'Inactive', 'Closed') NOT NULL DEFAULT 'Active',
  notes VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_budgets_period (department_id, period_type, fiscal_year, period_month),
  KEY idx_budgets_dates (period_start, period_end),
  CONSTRAINT chk_budgets_amount CHECK (allocated_amount >= 0),
  CONSTRAINT chk_budgets_threshold CHECK (warning_threshold > 0 AND warning_threshold <= 100),
  CONSTRAINT chk_budgets_month CHECK (period_month BETWEEN 0 AND 12),
  CONSTRAINT fk_budgets_department FOREIGN KEY (department_id) REFERENCES departments (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_budgets_created_by FOREIGN KEY (created_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS budget_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  budget_id INT UNSIGNED NOT NULL,
  purchase_order_id INT NULL,
  delivery_id INT UNSIGNED NULL,
  transaction_type ENUM('Commitment', 'Commitment Release', 'Actual') NOT NULL,
  amount DECIMAL(14, 2) NOT NULL,
  description VARCHAR(500) NOT NULL,
  dedupe_key VARCHAR(120) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_budget_transactions_dedupe (dedupe_key),
  KEY idx_budget_transactions_budget (budget_id, created_at),
  KEY idx_budget_transactions_po (purchase_order_id),
  CONSTRAINT fk_budget_transactions_budget FOREIGN KEY (budget_id) REFERENCES budgets (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_budget_transactions_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_budget_transactions_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_budget_transactions_user FOREIGN KEY (created_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

ALTER TABLE purchase_orders
  ADD COLUMN budget_id INT UNSIGNED NULL AFTER department_id,
  ADD CONSTRAINT fk_purchase_orders_budget FOREIGN KEY (budget_id)
    REFERENCES budgets (id) ON UPDATE CASCADE ON DELETE RESTRICT;

SET @buildsync_batch = (SELECT COALESCE(MAX(batch), 0) + 1 FROM schema_migrations);
INSERT INTO schema_migrations (migration, batch) VALUES
  ('004_auth_rbac.sql', @buildsync_batch),
  ('005_activity_notifications.sql', @buildsync_batch),
  ('006_products_inventory.sql', @buildsync_batch),
  ('007_requisitions_approvals.sql', @buildsync_batch),
  ('008_purchase_order_items.sql', @buildsync_batch),
  ('009_deliveries.sql', @buildsync_batch),
  ('010_budgets.sql', @buildsync_batch);
