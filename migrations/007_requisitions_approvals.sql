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
