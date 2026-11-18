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
