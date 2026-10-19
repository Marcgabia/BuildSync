const express = require('express');
const router = express.Router();
const db = require('../database');

// Get all POs
router.get('/', (req, res) => {
  const query = `SELECT po.*, s.vendor_name FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id`;
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error.");
    }
    db.all("SELECT * FROM suppliers", [], (err2, suppliers) => {
      res.render('purchase-orders', { pos: rows, suppliers: suppliers });
    });
  });
});

// Create PO
router.post('/add', (req, res) => {
  const { po_number, supplier_id, item_sku, description, quantity_ordered, unit_cost, target_date } = req.body;
  const total_cost = quantity_ordered * unit_cost;

  const query = `INSERT INTO purchase_orders (po_number, supplier_id, item_sku, description, quantity_ordered, unit_cost, total_cost, status, target_date) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending Approval', ?)`;

  db.run(query, [po_number, supplier_id, item_sku, description, quantity_ordered, unit_cost, total_cost, target_date], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error creating PO.");
    }
    res.redirect('/purchase-orders');
  });
});

module.exports = router;