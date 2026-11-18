const { pool } = require('../lib/db');
const { handle, paramId } = require('../lib/http');
const approvals = require('../services/approvals');
const settings = require('../services/settings');
const { action } = require('./helpers');

const index = handle(async (req, res) => {
  const connection = pool();
  let requisitions = [];
  let orders = [];
  if (req.can('requisitions.approve')) {
    [requisitions] = await connection.execute(
      `SELECT r.*, u.full_name AS requester_name, d.name AS department_name,
              (SELECT COUNT(*) FROM requisition_items i WHERE i.requisition_id = r.id) AS item_count
       FROM purchase_requisitions r JOIN users u ON u.id = r.requested_by JOIN departments d ON d.id = r.department_id
       WHERE r.status IN ('Submitted', 'Under Review') ORDER BY r.submitted_at, r.id`
    );
    for (const record of requisitions) record.decision = await approvals.eligibility(connection, req, 'requisition', record);
  }
  if (req.can('purchase_orders.approve')) {
    [orders] = await connection.execute(
      `SELECT po.*, s.vendor_name, u.full_name AS created_by_name, d.name AS department_name
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.created_by LEFT JOIN departments d ON d.id = po.department_id
       WHERE po.status = 'Pending Approval' ORDER BY po.submitted_at, po.id`
    );
    for (const record of orders) record.decision = await approvals.eligibility(connection, req, 'purchase_order', record);
  }
  const [history] = await connection.execute(
    `SELECT a.*, u.full_name AS approver_name,
            COALESCE(r.requisition_number, po.po_number) AS reference_number
     FROM approvals a JOIN users u ON u.id = a.approver_id
     LEFT JOIN purchase_requisitions r ON a.reference_type = 'requisition' AND r.id = a.reference_id
     LEFT JOIN purchase_orders po ON a.reference_type = 'purchase_order' AND po.id = a.reference_id
     ORDER BY a.approved_at DESC, a.id DESC LIMIT 20`
  );
  res.render('approvals/index', {
    requisitions, orders, history,
    levels: {
      requisition: await settings.getNumber('requisition_approval_levels'),
      purchase_order: await settings.getNumber('po_approval_levels')
    }
  });
});

const messages = {
  level: 'Approval recorded. The request now needs the next approval level.',
  approved: 'Request approved.',
  rejected: 'Request rejected.',
  returned: 'Request returned for revision.'
};

function decide(referenceType, path) {
  return action(async (req) => {
    const id = paramId(req);
    const result = await approvals.decide(req, referenceType, id, req.body.decision, req.body.comments);
    return { ...result, redirect: req.body.return_to === 'approvals' ? '/approvals' : `${path}/${id}` };
  }, { success: (result) => messages[result.outcome], redirect: '/approvals' });
}

module.exports = {
  index,
  decideRequisition: decide('requisition', '/requisitions'),
  decidePurchaseOrder: decide('purchase_order', '/purchase-orders')
};
