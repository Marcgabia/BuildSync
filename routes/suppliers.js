const express = require('express');
const router = express.Router();
const db = require('../database');

// Get all suppliers
router.get('/', (req, res) => {
  db.all("SELECT * FROM suppliers", [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error.");
    }
    res.render('suppliers', { suppliers: rows });
  });
});

// Add new supplier
router.post('/add', (req, res) => {
  const { supplier_code, vendor_name, key_account_manager, contact_number, email, warehouse_address, material_category, credit_terms, delivery_lead_time } = req.body;
  
  const query = `INSERT INTO suppliers (supplier_code, vendor_name, key_account_manager, contact_number, email, warehouse_address, material_category, credit_terms, delivery_lead_time, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`;
  
  db.run(query, [supplier_code, vendor_name, key_account_manager, contact_number, email, warehouse_address, material_category, credit_terms, delivery_lead_time], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error adding supplier.");
    }
    res.redirect('/suppliers');
  });
});

module.exports = router;