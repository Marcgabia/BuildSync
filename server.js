const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const db = require('./database');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static('public'));

// Routes
const supplierRoutes = require('./routes/suppliers');
const poRoutes = require('./routes/purchaseOrders');

app.use('/suppliers', supplierRoutes);
app.use('/purchase-orders', poRoutes);

// Home route
app.get('/', (req, res) => {
  res.render('layout', { 
    title: 'Dashboard | BuildSync - Mindoro Tech',
    body: `
      <div class="p-6">
        <h1 class="text-2xl font-bold text-slate-800">Welcome to BuildSync Procurement Module</h1>
        <p class="text-slate-600 mt-2">Mindoro Tech Hardware & BuildSupply Corp. - Calapan City Central Hub</p>
        <div class="mt-6 flex gap-4">
          <a href="/suppliers" class="bg-blue-600 text-white px-4 py-2 rounded shadow hover:bg-blue-700">Manage Suppliers</a>
          <a href="/purchase-orders" class="bg-emerald-600 text-white px-4 py-2 rounded shadow hover:bg-emerald-700">View Purchase Orders</a>
        </div>
      </div>
    `
  });
});

app.listen(PORT, () => {
  console.log(`BuildSync server is running on http://localhost:${PORT}`);
});