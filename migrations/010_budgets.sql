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
