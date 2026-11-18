const { withTransaction } = require('../lib/db');
const v = require('../lib/validate');
const { forbidden, notFound } = require('../lib/http');
const { money } = require('../lib/format');
const audit = require('./audit');
const notifications = require('./notifications');
const settings = require('./settings');
const budget = require('./budget');

const decisions = { approve: 'Approved', reject: 'Rejected', return: 'Returned' };

const config = {
  requisition: {
    table: 'purchase_requisitions',
    numberColumn: 'requisition_number',
    ownerColumn: 'requested_by',
    permission: 'requisitions.approve',
    pendingStatuses: ['Submitted', 'Under Review'],
    levelsSetting: 'requisition_approval_levels',
    label: 'Requisition',
    module: 'Requisitions',
    link: (id) => `/requisitions/${id}`
  },
  purchase_order: {
    table: 'purchase_orders',
    numberColumn: 'po_number',
    ownerColumn: 'created_by',
    permission: 'purchase_orders.approve',
    pendingStatuses: ['Pending Approval'],
    levelsSetting: 'po_approval_levels',
    label: 'Purchase order',
    module: 'Purchase Orders',
    link: (id) => `/purchase-orders/${id}`
  }
};

async function history(connection, referenceType, referenceId) {
  const [rows] = await connection.execute(
    `SELECT a.*, u.full_name AS approver_name FROM approvals a
     JOIN users u ON u.id = a.approver_id
     WHERE a.reference_type = ? AND a.reference_id = ? ORDER BY a.approved_at, a.id`,
    [referenceType, referenceId]
  );
  return rows;
}

/** Tells the view whether the current user can decide on this record right now. */
async function eligibility(connection, req, referenceType, record) {
  const cfg = config[referenceType];
  if (!req.can(cfg.permission)) return { allowed: false, reason: null };
  if (!cfg.pendingStatuses.includes(record.status)) return { allowed: false, reason: null };
  const allowSelf = (await settings.get('allow_self_approval', connection)) === '1';
  if (!allowSelf && Number(record[cfg.ownerColumn]) === req.user.id) {
    return { allowed: false, reason: 'You created this request, so another approver must review it.' };
  }
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM approvals WHERE reference_type = ? AND reference_id = ?
       AND approver_id = ? AND status = 'Approved' AND approved_at >= ?`,
    [referenceType, record.id, req.user.id, record.submitted_at || '1970-01-01']
  );
  if (Number(rows[0].total)) return { allowed: false, reason: 'You already approved an earlier level; a different approver must continue.' };
  const levels = await settings.getNumber(cfg.levelsSetting, connection);
  return { allowed: true, level: Number(record.current_approval_level) + 1, levels };
}

/**
 * Records an approval decision (approve / reject / return) with full audit,
 * notification, multi-level approval, and budget commitment handling.
 */
async function decide(req, referenceType, id, decisionKey, commentsInput) {
  const cfg = config[referenceType];
  if (!cfg) throw notFound();
  const status = decisions[decisionKey];
  if (!status) v.fail('Choose approve, reject, or return.');
  const comments = v.optionalText(commentsInput, 'Comments', 2000);
  if (status !== 'Approved' && !comments) v.fail('Add a comment explaining why the request is being rejected or returned.');
  if (!req.can(cfg.permission)) throw forbidden();

  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(`SELECT * FROM ${cfg.table} WHERE id = ? FOR UPDATE`, [id]);
    const record = rows[0];
    if (!record) throw notFound();
    if (!cfg.pendingStatuses.includes(record.status)) {
      v.fail(`This ${cfg.label.toLowerCase()} is "${record.status}" and is no longer awaiting approval.`);
    }
    const check = await eligibility(connection, req, referenceType, record);
    if (!check.allowed) throw forbidden(check.reason || undefined);
    const number = record[cfg.numberColumn];

    await connection.execute(
      `INSERT INTO approvals (reference_type, reference_id, approval_level, approver_id, status, comments)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [referenceType, id, check.level, req.user.id, status, comments]
    );

    let outcome;
    let warning = null;
    if (status === 'Approved' && check.level < check.levels) {
      outcome = 'level';
      if (referenceType === 'requisition') {
        await connection.execute(
          "UPDATE purchase_requisitions SET status = 'Under Review', current_approval_level = ? WHERE id = ?",
          [check.level, id]
        );
      } else {
        await connection.execute('UPDATE purchase_orders SET current_approval_level = ? WHERE id = ?', [check.level, id]);
      }
      await notifications.notifyPermission(connection, cfg.permission, {
        type: referenceType === 'requisition' ? 'requisition_submitted' : 'po_pending_approval',
        title: `${cfg.label} ${number} needs level ${check.level + 1} approval`,
        message: `${req.user.fullName} approved level ${check.level} of ${check.levels}.`,
        link: cfg.link(id), referenceType, referenceId: id
      }, { exceptUserId: req.user.id });
    } else if (status === 'Approved') {
      outcome = 'approved';
      if (referenceType === 'requisition') {
        await connection.execute(
          "UPDATE purchase_requisitions SET status = 'Approved', current_approval_level = ?, decided_at = NOW() WHERE id = ?",
          [check.level, id]
        );
        await notifications.notifyPermission(connection, 'purchase_orders.manage', {
          type: 'requisition_decision',
          title: `Requisition ${number} is ready for a purchase order`,
          message: 'The requisition was approved and can now be converted into a purchase order.',
          link: cfg.link(id), referenceType, referenceId: id
        });
      } else {
        await connection.execute(
          `UPDATE purchase_orders SET status = 'Approved', current_approval_level = ?, approved_by = ?,
             approved_at = NOW() WHERE id = ?`,
          [check.level, req.user.id, id]
        );
        const committed = await budget.commitOrder(connection, record, req.user.id);
        warning = committed.warning;
      }
    } else if (status === 'Rejected') {
      outcome = 'rejected';
      if (referenceType === 'requisition') {
        await connection.execute(
          "UPDATE purchase_requisitions SET status = 'Rejected', decided_at = NOW() WHERE id = ?", [id]
        );
      } else {
        await connection.execute(
          `UPDATE purchase_orders SET status = 'Cancelled', cancelled_at = NOW(), cancel_reason = ? WHERE id = ?`,
          [`Rejected by ${req.user.fullName}: ${comments}`.slice(0, 500), id]
        );
        if (record.requisition_id) {
          await connection.execute(
            "UPDATE purchase_requisitions SET status = 'Approved' WHERE id = ? AND status = 'Converted to Purchase Order'",
            [record.requisition_id]
          );
        }
      }
    } else {
      outcome = 'returned';
      if (referenceType === 'requisition') {
        await connection.execute(
          "UPDATE purchase_requisitions SET status = 'Returned for Revision', current_approval_level = 0 WHERE id = ?", [id]
        );
      } else {
        await connection.execute(
          "UPDATE purchase_orders SET status = 'Draft', current_approval_level = 0 WHERE id = ?", [id]
        );
      }
    }

    const verb = { level: `approved level ${check.level} of`, approved: 'approved', rejected: 'rejected', returned: 'returned for revision' }[outcome];
    await audit.log(connection, req, {
      action: `approval.${decisionKey}`, module: 'Approvals', recordId: `${referenceType}:${id}`,
      description: `${req.user.fullName} ${verb} ${cfg.label.toLowerCase()} ${number}` +
        `${referenceType === 'purchase_order' ? ` (${money(record.total_cost)})` : ''}${comments ? `: ${comments}` : '.'}`
    });
    if (outcome !== 'level') {
      await notifications.notifyUser(connection, record[cfg.ownerColumn], {
        type: referenceType === 'requisition' ? 'requisition_decision' : (outcome === 'approved' ? 'po_approved' : 'po_decision'),
        title: `${cfg.label} ${number} was ${outcome === 'returned' ? 'returned for revision' : outcome}`,
        message: comments ? `${req.user.fullName}: ${comments}` : `Decision by ${req.user.fullName}.`,
        link: cfg.link(id), referenceType, referenceId: id
      });
    }
    return { outcome, warning };
  });
}

module.exports = { decide, eligibility, history, config };
