const { pool, withTransaction } = require('../lib/db');
const v = require('../lib/validate');
const { handle, paramId, paginate, notFound, isDuplicateError, isUserError, sendCsv } = require('../lib/http');
const { Product, Category } = require('../models/product');
const audit = require('../services/audit');
const inventory = require('../services/inventory');
const { action } = require('./helpers');

const productStatuses = ['Active', 'Inactive'];
const adjustmentTypes = ['Adjustment In', 'Adjustment Out'];

function readFilters(query) {
  return {
    search: String(query.q || '').trim().slice(0, 100),
    categoryId: v.isValidId(query.category) ? Number(query.category) : 0,
    status: productStatuses.includes(query.status) ? query.status : 'All',
    lowStock: query.low === '1'
  };
}

async function formOptions() {
  const [categories, suppliers] = await Promise.all([
    Category.active(),
    pool().execute("SELECT id, vendor_name, supplier_code FROM suppliers WHERE status = 'Active' ORDER BY vendor_name")
      .then(([rows]) => rows)
  ]);
  return { categories, suppliers, statuses: productStatuses };
}

function validateProduct(body, { isNew }) {
  const values = {
    product_code: v.text(body.product_code, 'SKU / product code', { max: 60 }).toUpperCase(),
    name: v.text(body.name, 'Product name', { max: 200 }),
    category_id: v.id(body.category_id, 'Category'),
    description: v.optionalText(body.description, 'Description', 5000),
    unit: v.text(body.unit, 'Unit of measurement', { max: 30 }),
    supplier_id: String(body.supplier_id || '').trim() ? v.id(body.supplier_id, 'Supplier') : null,
    unit_price: v.centsToAmount(v.moneyCents(body.unit_price, 'Unit price', { max: 9999999999 })),
    minimum_stock: v.integer(body.minimum_stock || 0, 'Minimum stock level', { min: 0, max: 100000000 }),
    status: v.oneOf(body.status || 'Active', 'Status', productStatuses)
  };
  if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(values.product_code)) {
    v.fail('SKU may only contain letters, numbers, dots, dashes, and slashes.');
  }
  if (isNew) values.opening_stock = v.integer(body.opening_stock || 0, 'Opening stock', { min: 0, max: 100000000 });
  return values;
}

const list = handle(async (req, res) => {
  const filters = readFilters(req.query);
  const pageInfo = paginate(await Product.count(filters), req.query.page, 15);
  const products = await Product.list({ ...filters, limit: pageInfo.pageSize, offset: pageInfo.offset });
  res.render('products/index', {
    products, filters, pageInfo, counts: await Product.counts(), ...(await formOptions()),
    error: null, values: {}
  });
});

const exportCsv = handle(async (req, res) => {
  const products = await Product.list(readFilters(req.query));
  sendCsv(res, 'products.csv', [
    { label: 'SKU', key: 'product_code' }, { label: 'Product', key: 'name' }, { label: 'Category', key: 'category_name' },
    { label: 'Unit', key: 'unit' }, { label: 'Supplier', key: 'supplier_name' }, { label: 'Unit price', key: 'unit_price' },
    { label: 'Current stock', key: 'current_stock' }, { label: 'Minimum stock', key: 'minimum_stock' },
    { label: 'Status', key: 'status' }, { label: 'Date created', key: 'created_at' }
  ], products);
});

const create = handle(async (req, res) => {
  try {
    const values = validateProduct(req.body, { isNew: true });
    const id = await withTransaction(async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO products
          (product_code, name, category_id, description, unit, supplier_id, unit_price, minimum_stock, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [values.product_code, values.name, values.category_id, values.description, values.unit, values.supplier_id,
          values.unit_price, values.minimum_stock, values.status, req.user.id]
      );
      if (values.opening_stock > 0) {
        await inventory.postMovement(connection, {
          productId: result.insertId, quantity: values.opening_stock, type: 'Opening',
          notes: 'Opening stock balance', userId: req.user.id
        });
      }
      await audit.log(connection, req, {
        action: 'create', module: 'Products', recordId: result.insertId,
        description: `Added product ${values.name} (${values.product_code}) with opening stock ${values.opening_stock}.`
      });
      return result.insertId;
    });
    await req.flash('success', 'Product created successfully.');
    res.redirect(`/products/${id}`);
  } catch (error) {
    const message = isDuplicateError(error) ? 'That SKU / product code is already in use.'
      : error.code === 'ER_NO_REFERENCED_ROW_2' ? 'The selected category or supplier no longer exists.'
        : isUserError(error) ? error.message : null;
    if (!message) throw error;
    const filters = readFilters({});
    const pageInfo = paginate(await Product.count(filters), 1, 15);
    res.status(400).render('products/index', {
      products: await Product.list({ ...filters, limit: pageInfo.pageSize, offset: 0 }), filters, pageInfo,
      counts: await Product.counts(), ...(await formOptions()), error: message, values: req.body
    });
  }
});

const view = handle(async (req, res) => {
  const product = await Product.findById(paramId(req));
  if (!product) throw notFound();
  const [movements, [orders]] = await Promise.all([
    Product.movements(product.id, 50),
    pool().execute(
      `SELECT po.id, po.po_number, po.status, po.order_date, i.quantity, i.received_quantity, i.unit_price, s.vendor_name
       FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.purchase_order_id
       JOIN suppliers s ON s.id = po.supplier_id WHERE i.product_id = ? ORDER BY po.created_at DESC LIMIT 20`,
      [product.id]
    )
  ]);
  res.render('products/show', {
    product, movements, orders, adjustmentTypes, canDelete: await Product.dependencyCount(product.id) === 0
  });
});

const editForm = handle(async (req, res) => {
  const product = await Product.findById(paramId(req));
  if (!product) throw notFound();
  res.render('products/edit', { product, values: product, error: null, ...(await formOptions()) });
});

const update = handle(async (req, res) => {
  const id = paramId(req);
  const product = await Product.findById(id);
  if (!product) throw notFound();
  try {
    const values = validateProduct(req.body, { isNew: false });
    await pool().execute(
      `UPDATE products SET product_code = ?, name = ?, category_id = ?, description = ?, unit = ?, supplier_id = ?,
         unit_price = ?, minimum_stock = ?, status = ? WHERE id = ?`,
      [values.product_code, values.name, values.category_id, values.description, values.unit, values.supplier_id,
        values.unit_price, values.minimum_stock, values.status, id]
    );
    await audit.log(null, req, {
      action: 'update', module: 'Products', recordId: id,
      description: `Updated product ${values.name} (${values.product_code}); price ${values.unit_price}, minimum ${values.minimum_stock}, status ${values.status}.`
    });
    await req.flash('success', 'Product updated successfully.');
    res.redirect(`/products/${id}`);
  } catch (error) {
    const message = isDuplicateError(error) ? 'That SKU / product code is already in use.'
      : isUserError(error) ? error.message : null;
    if (!message) throw error;
    res.status(400).render('products/edit', { product, values: { ...product, ...req.body }, error: message, ...(await formOptions()) });
  }
});

const remove = action(async (req) => {
  const id = paramId(req);
  const product = await Product.findById(id);
  if (!product) throw notFound();
  if (await Product.dependencyCount(id) > 0) {
    v.fail('This product is used by requisitions, purchase orders, deliveries, or stock movements. Set it to Inactive instead.');
  }
  await withTransaction(async (connection) => {
    await connection.execute("DELETE FROM inventory_transactions WHERE product_id = ? AND transaction_type = 'Opening'", [id]);
    await connection.execute('DELETE FROM products WHERE id = ?', [id]);
    await audit.log(connection, req, {
      action: 'delete', module: 'Products', recordId: id, description: `Deleted product ${product.name} (${product.product_code}).`
    });
  });
}, { success: 'Product deleted.', redirect: '/products' });

const adjust = action(async (req) => {
  const id = paramId(req);
  const type = v.oneOf(req.body.type, 'Adjustment type', adjustmentTypes);
  const quantity = v.integer(req.body.quantity, 'Quantity', { min: 1, max: 100000000 });
  const notes = v.text(req.body.notes, 'Reason for the adjustment', { max: 500 });
  await withTransaction(async (connection) => {
    const balance = await inventory.postMovement(connection, {
      productId: id, quantity: type === 'Adjustment In' ? quantity : -quantity, type, notes, userId: req.user.id
    });
    await audit.log(connection, req, {
      action: 'adjust', module: 'Inventory', recordId: id,
      description: `${type} of ${quantity} for product #${id}: ${notes}. New balance ${balance}.`
    });
  });
}, { success: 'Stock adjustment recorded.', redirect: (req) => `/products/${req.params.id}` });

/* ---------------- Categories ---------------- */

const categories = handle(async (req, res) => {
  res.render('products/categories', {
    categories: await Category.list({ search: String(req.query.q || '').trim().slice(0, 100) }),
    search: String(req.query.q || ''), error: null, values: {}, editing: null
  });
});

function validateCategory(body) {
  return {
    name: v.text(body.name, 'Category name', { max: 120 }),
    description: v.optionalText(body.description, 'Description', 500),
    is_active: body.is_active === '0' ? 0 : 1
  };
}

const createCategory = action(async (req) => {
  const values = validateCategory(req.body);
  try {
    const [result] = await pool().execute(
      'INSERT INTO categories (name, description, is_active) VALUES (?, ?, ?)', [values.name, values.description, values.is_active]
    );
    await audit.log(null, req, { action: 'create', module: 'Products', recordId: `category:${result.insertId}`, description: `Added category ${values.name}.` });
  } catch (error) {
    if (isDuplicateError(error)) v.fail('A category with that name already exists.');
    throw error;
  }
}, { success: 'Category created.', redirect: '/products/categories' });

const editCategory = handle(async (req, res) => {
  const category = await Category.findById(paramId(req));
  if (!category) throw notFound();
  res.render('products/category-edit', { category, error: null });
});

const updateCategory = action(async (req) => {
  const id = paramId(req);
  if (!await Category.findById(id)) throw notFound();
  const values = validateCategory(req.body);
  try {
    await pool().execute('UPDATE categories SET name = ?, description = ?, is_active = ? WHERE id = ?',
      [values.name, values.description, values.is_active, id]);
    await audit.log(null, req, { action: 'update', module: 'Products', recordId: `category:${id}`, description: `Updated category ${values.name}.` });
  } catch (error) {
    if (isDuplicateError(error)) v.fail('A category with that name already exists.');
    throw error;
  }
}, { success: 'Category updated.', redirect: '/products/categories' });

const deleteCategory = action(async (req) => {
  const id = paramId(req);
  const category = await Category.findById(id);
  if (!category) throw notFound();
  const [[row]] = await pool().execute('SELECT COUNT(*) AS total FROM products WHERE category_id = ?', [id]);
  if (Number(row.total) > 0) v.fail('This category still has products. Move or delete them first, or deactivate the category.');
  await pool().execute('DELETE FROM categories WHERE id = ?', [id]);
  await audit.log(null, req, { action: 'delete', module: 'Products', recordId: `category:${id}`, description: `Deleted category ${category.name}.` });
}, { success: 'Category deleted.', redirect: '/products/categories' });

/* ---------------- Inventory overview ---------------- */

const inventoryOverview = handle(async (req, res) => {
  const search = String(req.query.q || '').trim().slice(0, 100);
  const type = ['Opening', 'Receipt', 'Adjustment In', 'Adjustment Out'].includes(req.query.type) ? req.query.type : 'All';
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
  const where = `WHERE (? = '' OR p.name LIKE ? OR p.product_code LIKE ?) AND (? = 'All' OR t.transaction_type = ?)
    AND (? IS NULL OR DATE(t.created_at) >= ?) AND (? IS NULL OR DATE(t.created_at) <= ?)`;
  const params = [search, `%${search}%`, `%${search}%`, type, type, from || null, from || null, to || null, to || null];
  const [[countRow]] = await pool().execute(
    `SELECT COUNT(*) AS total FROM inventory_transactions t JOIN products p ON p.id = t.product_id ${where}`, params
  );
  const pageInfo = paginate(countRow.total, req.query.page, 20);
  const [movements] = await pool().execute(
    `SELECT t.*, p.name AS product_name, p.product_code, p.unit, u.full_name AS user_name
     FROM inventory_transactions t JOIN products p ON p.id = t.product_id
     LEFT JOIN users u ON u.id = t.created_by ${where}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, pageInfo.pageSize, pageInfo.offset]
  );
  const lowStock = await Product.list({ lowStock: true, status: 'Active' });
  res.render('products/inventory', {
    movements, pageInfo, filters: { search, type, from, to }, lowStock, counts: await Product.counts()
  });
});

module.exports = {
  list, exportCsv, create, view, editForm, update, remove, adjust,
  categories, createCategory, editCategory, updateCategory, deleteCategory, inventoryOverview
};
