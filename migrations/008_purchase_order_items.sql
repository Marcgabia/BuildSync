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
