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
