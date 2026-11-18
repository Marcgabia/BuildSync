const Supplier = require('../models/supplier');
const PurchaseOrder = require('../models/purchaseOrder');
const Dashboard = require('../models/dashboard');
const settings = require('../services/settings');
const { statuses: orderStatuses } = require('../services/purchaseOrders');

function createDashboardController(
  supplier = new Supplier(),
  purchaseOrder = new PurchaseOrder()
) {
  return async (req, res, next) => {
    try {
      if (req.can && !req.can('dashboard.view')) {
        return res.render('dashboard-limited');
      }
      const upcomingDays = await settings.getNumber('upcoming_delivery_days');
      const [supplierCounts, orderCounts, recentOrders, stats, monthly, statusMap, activity, upcoming, alerts] =
        await Promise.all([
          supplier.counts(),
          purchaseOrder.counts(),
          purchaseOrder.recent(5),
          Dashboard.stats(),
          Dashboard.monthlyExpenses(12),
          Dashboard.orderStatusCounts(),
          Dashboard.recentActivity(10),
          Dashboard.upcomingDeliveries(8),
          Dashboard.alerts(upcomingDays)
        ]);
      const statusCounts = orderStatuses.map((status) => ({ status, total: statusMap.get(status) || 0 }));
      res.render('layout', {
        supplierCounts, orderCounts, recentOrders, stats, monthly, statusCounts, activity, upcoming, alerts, upcomingDays
      });
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createDashboardController };
