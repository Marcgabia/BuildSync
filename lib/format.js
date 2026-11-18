const moneyFormatter = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const compactMoneyFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency', currency: 'PHP', maximumFractionDigits: 0
});
const numberFormatter = new Intl.NumberFormat('en-PH');

function money(value) {
  return moneyFormatter.format(Number(value || 0));
}

function moneyShort(value) {
  return compactMoneyFormatter.format(Number(value || 0));
}

function number(value) {
  return numberFormatter.format(Number(value || 0));
}

function date(value) {
  if (!value) return '—';
  return String(value).slice(0, 10);
}

function dateTime(value) {
  if (!value) return '—';
  return String(value).slice(0, 16).replace('T', ' ');
}

const statusTones = {
  good: ['Active', 'Approved', 'Completed', 'Fully Received', 'Converted to Purchase Order', 'Ordered'],
  pending: ['Pending', 'Pending Approval', 'Submitted', 'Under Review', 'In Transit', 'Partially Received',
    'Returned for Revision', 'Pending Qualification', 'Draft'],
  bad: ['Rejected', 'Cancelled', 'Delayed', 'Locked'],
  muted: ['Inactive', 'Closed']
};

function statusClass(status) {
  if (statusTones.good.includes(status)) return 'status-active';
  if (statusTones.bad.includes(status)) return 'status-danger';
  if (statusTones.muted.includes(status)) return 'status-inactive';
  if (statusTones.pending.includes(status)) return 'status-pending';
  return '';
}

function percent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

module.exports = { money, moneyShort, number, date, dateTime, statusClass, percent };
