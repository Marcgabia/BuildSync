const { pool } = require('../lib/db');
const { withDerived, balanceSelect } = require('../services/budget');

/**
 * Report registry. Every report is a parameterized SQL query; `columns` drive the
 * on-screen table, CSV export, and printable view. Columns with `total: true`
 * are summed in the footer. Filters: from, to (dates), status, search.
 */
const dateRange = (column) => `(? IS NULL OR ${column} >= ?) AND (? IS NULL OR ${column} <= ?)`;
const range = (f) => [f.from || null, f.from || null, f.to || null, f.to || null];
const like = (f) => `%${f.search}%`;

const reports = {
  'supplier-directory': {
    group: 'Supplier reports', title: 'Supplier directory', description: 'All suppliers with contact details and terms.',
    statuses: ['Active', 'Pending Qualification', 'Inactive'], dated: false,
    columns: [
      { key: 'supplier_code', label: 'Code' }, { key: 'vendor_name', label: 'Supplier' },
      { key: 'key_account_manager', label: 'Contact person' }, { key: 'email', label: 'Email' },
      { key: 'contact_number', label: 'Phone' }, { key: 'material_category', label: 'Category' },
      { key: 'tax_id', label: 'TIN' }, { key: 'credit_terms', label: 'Terms (days)', type: 'number' },
      { key: 'status', label: 'Status', type: 'status' }, { key: 'created_at', label: 'Registered', type: 'date' }
    ],
    query: (f) => [`SELECT * FROM suppliers WHERE (? = 'All' OR status = ?) AND (? = '' OR vendor_name LIKE ? OR supplier_code LIKE ?)
      ORDER BY vendor_name`, [f.status, f.status, f.search, like(f), like(f)]]
  },
  'supplier-purchases': {
    group: 'Supplier reports', title: 'Supplier purchase history', description: 'Order count and value per supplier for the period.',
    dated: true,
    columns: [
      { key: 'vendor_name', label: 'Supplier' }, { key: 'orders', label: 'Orders', type: 'number', total: true },
      { key: 'completed', label: 'Completed', type: 'number', total: true },
      { key: 'cancelled', label: 'Cancelled', type: 'number', total: true },
      { key: 'order_value', label: 'Order value (excl. cancelled)', type: 'money', total: true },
      { key: 'last_order', label: 'Last order', type: 'date' }
    ],
    query: (f) => [`SELECT s.vendor_name, COUNT(po.id) AS orders, COALESCE(SUM(po.status = 'Completed'), 0) AS completed,
        COALESCE(SUM(po.status = 'Cancelled'), 0) AS cancelled,
        COALESCE(SUM(CASE WHEN po.status <> 'Cancelled' THEN po.total_cost END), 0) AS order_value, MAX(po.order_date) AS last_order
      FROM suppliers s JOIN purchase_orders po ON po.supplier_id = s.id
      WHERE ${dateRange('po.order_date')} AND (? = '' OR s.vendor_name LIKE ?)
      GROUP BY s.id ORDER BY order_value DESC`, [...range(f), f.search, like(f)]]
  },
  'supplier-performance': {
    group: 'Supplier reports', title: 'Supplier performance evaluation',
    description: 'On-time delivery rate, accepted-quantity rate, and service reliability rating.', dated: true,
    columns: [
      { key: 'vendor_name', label: 'Supplier' }, { key: 'deliveries', label: 'Deliveries', type: 'number', total: true },
      { key: 'on_time_rate', label: 'On-time %', type: 'percent' }, { key: 'acceptance_rate', label: 'Accepted %', type: 'percent' },
      { key: 'damaged', label: 'Damaged qty', type: 'number', total: true },
      { key: 'reliability_rating', label: 'Reliability (1–5)', type: 'number' }
    ],
    query: (f) => [`SELECT s.vendor_name, s.reliability_rating, COUNT(DISTINCT d.id) AS deliveries,
        100 * AVG(d.delivery_date <= COALESCE(d.expected_date, po.target_date)) AS on_time_rate,
        100 * SUM(di.accepted_quantity) / NULLIF(SUM(di.received_quantity), 0) AS acceptance_rate,
        COALESCE(SUM(di.damaged_quantity), 0) AS damaged
      FROM suppliers s
      JOIN deliveries d ON d.supplier_id = s.id AND d.confirmed_at IS NOT NULL
      JOIN purchase_orders po ON po.id = d.purchase_order_id
      LEFT JOIN delivery_items di ON di.delivery_id = d.id
      WHERE ${dateRange('d.delivery_date')} AND (? = '' OR s.vendor_name LIKE ?)
      GROUP BY s.id ORDER BY on_time_rate DESC`, [...range(f), f.search, like(f)]]
  },
  'requisition-summary': {
    group: 'Purchase requisition reports', title: 'Requisition summary by status',
    description: 'Total, approved, rejected, and pending requests.', dated: true,
    columns: [
      { key: 'status', label: 'Status', type: 'status' }, { key: 'total', label: 'Requests', type: 'number', total: true },
      { key: 'amount', label: 'Estimated value', type: 'money', total: true }
    ],
    query: (f) => [`SELECT status, COUNT(*) AS total, COALESCE(SUM(total_estimated), 0) AS amount
      FROM purchase_requisitions WHERE ${dateRange('request_date')} GROUP BY status ORDER BY total DESC`, range(f)]
  },
  'requisition-register': {
    group: 'Purchase requisition reports', title: 'Requisition register', description: 'Every requisition in the period.',
    statuses: ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Returned for Revision', 'Converted to Purchase Order', 'Cancelled'],
    dated: true,
    columns: [
      { key: 'requisition_number', label: 'Number' }, { key: 'request_date', label: 'Requested', type: 'date' },
      { key: 'requester', label: 'Requested by' }, { key: 'department', label: 'Department' },
      { key: 'required_date', label: 'Required', type: 'date' }, { key: 'status', label: 'Status', type: 'status' },
      { key: 'total_estimated', label: 'Estimated', type: 'money', total: true }
    ],
    query: (f) => [`SELECT r.requisition_number, r.request_date, u.full_name AS requester, d.name AS department,
        r.required_date, r.status, r.total_estimated
      FROM purchase_requisitions r JOIN users u ON u.id = r.requested_by JOIN departments d ON d.id = r.department_id
      WHERE ${dateRange('r.request_date')} AND (? = 'All' OR r.status = ?)
        AND (? = '' OR r.requisition_number LIKE ? OR u.full_name LIKE ?)
      ORDER BY r.request_date DESC, r.id DESC`, [...range(f), f.status, f.status, f.search, like(f), like(f)]]
  },
  'po-by-status': {
    group: 'Purchase order reports', title: 'Purchase orders by status', description: 'Order count and value per status.', dated: true,
    columns: [
      { key: 'status', label: 'Status', type: 'status' }, { key: 'orders', label: 'Orders', type: 'number', total: true },
      { key: 'amount', label: 'Total amount', type: 'money', total: true }
    ],
    query: (f) => [`SELECT status, COUNT(*) AS orders, COALESCE(SUM(total_cost), 0) AS amount FROM purchase_orders
      WHERE ${dateRange('order_date')} GROUP BY status ORDER BY FIELD(status, 'Draft', 'Pending Approval', 'Approved', 'Ordered',
      'Partially Received', 'Completed', 'Cancelled')`, range(f)]
  },
  'po-by-supplier': {
    group: 'Purchase order reports', title: 'Purchase orders by supplier', description: 'Procurement amounts per supplier.', dated: true,
    statuses: ['Draft', 'Pending Approval', 'Approved', 'Ordered', 'Partially Received', 'Completed', 'Cancelled'],
    columns: [
      { key: 'vendor_name', label: 'Supplier' }, { key: 'orders', label: 'Orders', type: 'number', total: true },
      { key: 'subtotal', label: 'Subtotal', type: 'money', total: true }, { key: 'discount', label: 'Discount', type: 'money', total: true },
      { key: 'tax', label: 'Tax', type: 'money', total: true }, { key: 'amount', label: 'Total', type: 'money', total: true }
    ],
    query: (f) => [`SELECT s.vendor_name, COUNT(*) AS orders, SUM(po.subtotal) AS subtotal, SUM(po.discount_amount) AS discount,
        SUM(po.tax_amount) AS tax, SUM(po.total_cost) AS amount
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE ${dateRange('po.order_date')} AND (? = 'All' OR po.status = ?) AND (? = '' OR s.vendor_name LIKE ?)
      GROUP BY s.id ORDER BY amount DESC`, [...range(f), f.status, f.status, f.search, like(f)]]
  },
  'po-register': {
    group: 'Purchase order reports', title: 'Purchase order register', description: 'Purchase orders by date range with totals.', dated: true,
    statuses: ['Draft', 'Pending Approval', 'Approved', 'Ordered', 'Partially Received', 'Completed', 'Cancelled'],
    columns: [
      { key: 'po_number', label: 'PO number' }, { key: 'order_date', label: 'Order date', type: 'date' },
      { key: 'vendor_name', label: 'Supplier' }, { key: 'department', label: 'Department' },
      { key: 'target_date', label: 'Expected', type: 'date' }, { key: 'status', label: 'Status', type: 'status' },
      { key: 'total_cost', label: 'Total', type: 'money', total: true }
    ],
    query: (f) => [`SELECT po.po_number, po.order_date, s.vendor_name, d.name AS department, po.target_date, po.status, po.total_cost
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN departments d ON d.id = po.department_id
      WHERE ${dateRange('po.order_date')} AND (? = 'All' OR po.status = ?) AND (? = '' OR po.po_number LIKE ? OR s.vendor_name LIKE ?)
      ORDER BY po.order_date DESC, po.id DESC`, [...range(f), f.status, f.status, f.search, like(f), like(f)]]
  },
  'stock-levels': {
    group: 'Inventory reports', title: 'Current stock levels', description: 'On-hand quantity and value for every product.', dated: false,
    statuses: ['Active', 'Inactive'],
    columns: [
      { key: 'product_code', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'category', label: 'Category' },
      { key: 'unit', label: 'Unit' }, { key: 'current_stock', label: 'On hand', type: 'number', total: true },
      { key: 'minimum_stock', label: 'Minimum', type: 'number' }, { key: 'unit_price', label: 'Unit price', type: 'money' },
      { key: 'stock_value', label: 'Stock value', type: 'money', total: true }
    ],
    query: (f) => [`SELECT p.product_code, p.name, c.name AS category, p.unit, p.current_stock, p.minimum_stock, p.unit_price,
        p.current_stock * p.unit_price AS stock_value
      FROM products p JOIN categories c ON c.id = p.category_id
      WHERE (? = 'All' OR p.status = ?) AND (? = '' OR p.name LIKE ? OR p.product_code LIKE ?) ORDER BY p.name`,
    [f.status, f.status, f.search, like(f), like(f)]]
  },
  'low-stock': {
    group: 'Inventory reports', title: 'Low-stock products', description: 'Active products at or below their minimum stock level.', dated: false,
    columns: [
      { key: 'product_code', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'supplier', label: 'Supplier' },
      { key: 'current_stock', label: 'On hand', type: 'number' }, { key: 'minimum_stock', label: 'Minimum', type: 'number' },
      { key: 'shortfall', label: 'Shortfall', type: 'number', total: true }
    ],
    query: (f) => [`SELECT p.product_code, p.name, s.vendor_name AS supplier, p.current_stock, p.minimum_stock,
        GREATEST(p.minimum_stock - p.current_stock, 0) AS shortfall
      FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.status = 'Active' AND p.minimum_stock > 0 AND p.current_stock <= p.minimum_stock
        AND (? = '' OR p.name LIKE ? OR p.product_code LIKE ?)
      ORDER BY p.current_stock / p.minimum_stock, p.name`, [f.search, like(f), like(f)]]
  },
  'stock-movements': {
    group: 'Inventory reports', title: 'Stock movement history', description: 'Every receipt and adjustment in the period.', dated: true,
    statuses: ['Opening', 'Receipt', 'Adjustment In', 'Adjustment Out'],
    columns: [
      { key: 'created_at', label: 'Date', type: 'datetime' }, { key: 'product_code', label: 'SKU' }, { key: 'name', label: 'Product' },
      { key: 'transaction_type', label: 'Type' }, { key: 'quantity', label: 'Qty', type: 'number', total: true },
      { key: 'balance_after', label: 'Balance', type: 'number' }, { key: 'user_name', label: 'By' }, { key: 'notes', label: 'Notes' }
    ],
    query: (f) => [`SELECT t.created_at, p.product_code, p.name, t.transaction_type, t.quantity, t.balance_after,
        u.full_name AS user_name, t.notes
      FROM inventory_transactions t JOIN products p ON p.id = t.product_id LEFT JOIN users u ON u.id = t.created_by
      WHERE ${dateRange('DATE(t.created_at)')} AND (? = 'All' OR t.transaction_type = ?)
        AND (? = '' OR p.name LIKE ? OR p.product_code LIKE ?)
      ORDER BY t.created_at DESC, t.id DESC`, [...range(f), f.status, f.status, f.search, like(f), like(f)]]
  },
  'received-items': {
    group: 'Inventory reports', title: 'Received items', description: 'Accepted quantities from confirmed deliveries.', dated: true,
    columns: [
      { key: 'delivery_date', label: 'Delivered', type: 'date' }, { key: 'delivery_number', label: 'Delivery' },
      { key: 'po_number', label: 'PO' }, { key: 'item_code', label: 'Item' }, { key: 'description', label: 'Description' },
      { key: 'received_quantity', label: 'Received', type: 'number', total: true },
      { key: 'damaged_quantity', label: 'Damaged', type: 'number', total: true },
      { key: 'accepted_quantity', label: 'Accepted', type: 'number', total: true },
      { key: 'accepted_value', label: 'Accepted value', type: 'money', total: true }
    ],
    query: (f) => [`SELECT d.delivery_date, d.delivery_number, po.po_number, i.item_code, i.description, di.received_quantity,
        di.damaged_quantity, di.accepted_quantity, di.accepted_quantity * i.unit_price AS accepted_value
      FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
      JOIN purchase_order_items i ON i.id = di.purchase_order_item_id JOIN purchase_orders po ON po.id = d.purchase_order_id
      WHERE d.confirmed_at IS NOT NULL AND ${dateRange('d.delivery_date')}
        AND (? = '' OR i.item_code LIKE ? OR i.description LIKE ? OR po.po_number LIKE ?)
      ORDER BY d.delivery_date DESC, d.id DESC`, [...range(f), f.search, like(f), like(f), like(f)]]
  },
  'delivery-register': {
    group: 'Delivery reports', title: 'Deliveries by status', description: 'Completed, partial, delayed, and rejected deliveries.', dated: true,
    statuses: ['Pending', 'In Transit', 'Partially Received', 'Fully Received', 'Delayed', 'Rejected'],
    columns: [
      { key: 'delivery_number', label: 'Delivery' }, { key: 'reference_number', label: 'Supplier ref.' },
      { key: 'po_number', label: 'PO' }, { key: 'vendor_name', label: 'Supplier' },
      { key: 'expected_date', label: 'Expected', type: 'date' }, { key: 'delivery_date', label: 'Delivered', type: 'date' },
      { key: 'days_late', label: 'Days late', type: 'number' }, { key: 'status', label: 'Status', type: 'status' },
      { key: 'accepted', label: 'Accepted qty', type: 'number', total: true }, { key: 'damaged', label: 'Damaged qty', type: 'number', total: true }
    ],
    query: (f) => [`SELECT d.delivery_number, d.reference_number, po.po_number, s.vendor_name, d.expected_date, d.delivery_date,
        GREATEST(DATEDIFF(COALESCE(d.delivery_date, CURDATE()), COALESCE(d.expected_date, po.target_date)), 0) AS days_late,
        d.status, COALESCE(SUM(di.accepted_quantity), 0) AS accepted, COALESCE(SUM(di.damaged_quantity), 0) AS damaged
      FROM deliveries d JOIN purchase_orders po ON po.id = d.purchase_order_id JOIN suppliers s ON s.id = d.supplier_id
      LEFT JOIN delivery_items di ON di.delivery_id = d.id
      WHERE ${dateRange('COALESCE(d.delivery_date, d.expected_date)')} AND (? = 'All' OR d.status = ?)
        AND (? = '' OR po.po_number LIKE ? OR s.vendor_name LIKE ?)
      GROUP BY d.id ORDER BY COALESCE(d.delivery_date, d.expected_date) DESC`, [...range(f), f.status, f.status, f.search, like(f), like(f)]]
  },
  'damaged-items': {
    group: 'Delivery reports', title: 'Damaged or rejected items', description: 'Delivery lines with damaged quantities.', dated: true,
    columns: [
      { key: 'delivery_date', label: 'Delivered', type: 'date' }, { key: 'delivery_number', label: 'Delivery' },
      { key: 'vendor_name', label: 'Supplier' }, { key: 'item_code', label: 'Item' },
      { key: 'received_quantity', label: 'Received', type: 'number', total: true },
      { key: 'damaged_quantity', label: 'Damaged', type: 'number', total: true }, { key: 'remarks', label: 'Remarks' }
    ],
    query: (f) => [`SELECT d.delivery_date, d.delivery_number, s.vendor_name, i.item_code, di.received_quantity,
        di.damaged_quantity, COALESCE(di.remarks, d.remarks) AS remarks
      FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id JOIN suppliers s ON s.id = d.supplier_id
      JOIN purchase_order_items i ON i.id = di.purchase_order_item_id
      WHERE di.damaged_quantity > 0 AND ${dateRange('d.delivery_date')} AND (? = '' OR s.vendor_name LIKE ? OR i.item_code LIKE ?)
      ORDER BY d.delivery_date DESC`, [...range(f), f.search, like(f), like(f)]]
  },
  'budget-utilization': {
    group: 'Budget reports', title: 'Budget utilization', description: 'Allocated, committed, actual, and remaining budget.', dated: true,
    statuses: ['Active', 'Inactive', 'Closed'],
    columns: [
      { key: 'name', label: 'Budget' }, { key: 'department_name', label: 'Department' }, { key: 'period', label: 'Period' },
      { key: 'allocated_amount', label: 'Allocated', type: 'money', total: true },
      { key: 'committed_amount', label: 'Committed', type: 'money', total: true },
      { key: 'actual_amount', label: 'Actual', type: 'money', total: true },
      { key: 'remaining_amount', label: 'Remaining', type: 'money', total: true },
      { key: 'utilization', label: 'Utilization', type: 'percent' }, { key: 'status', label: 'Status', type: 'status' }
    ],
    query: (f) => [`${balanceSelect}
      WHERE (? IS NULL OR b.period_end >= ?) AND (? IS NULL OR b.period_start <= ?) AND (? = 'All' OR b.status = ?)
        AND (? = '' OR b.name LIKE ? OR d.name LIKE ?)
      GROUP BY b.id ORDER BY b.period_start DESC, d.name`, [...range(f), f.status, f.status, f.search, like(f), like(f)]],
    transform: (rows) => rows.map(withDerived).map((b) => ({
      ...b, period: b.period_type === 'Monthly' ? `${b.fiscal_year}-${String(b.period_month).padStart(2, '0')}` : String(b.fiscal_year)
    }))
  }
};

async function run(key, filters) {
  const report = reports[key];
  const [sql, params] = report.query(filters);
  const [rows] = await pool().query(sql, params);
  const data = report.transform ? report.transform(rows) : rows;
  const totals = {};
  for (const column of report.columns.filter((c) => c.total)) {
    totals[column.key] = data.reduce((sum, row) => sum + Number(row[column.key] || 0), 0);
  }
  return { rows: data, totals };
}

module.exports = { reports, run };
