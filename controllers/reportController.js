const { handle, notFound, forbidden, sendCsv } = require('../lib/http');
const { reports, run } = require('../models/report');
const settings = require('../services/settings');
const audit = require('../services/audit');
const format = require('../lib/format');

function readFilters(query, report) {
  const valid = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '');
  return {
    from: report.dated ? valid(query.from) : '',
    to: report.dated ? valid(query.to) : '',
    status: report.statuses && report.statuses.includes(query.status) ? query.status : 'All',
    search: String(query.q || '').trim().slice(0, 100)
  };
}

function grouped() {
  const groups = new Map();
  for (const [key, report] of Object.entries(reports)) {
    if (!groups.has(report.group)) groups.set(report.group, []);
    groups.get(report.group).push({ key, ...report });
  }
  return [...groups.entries()];
}

const index = handle(async (req, res) => {
  res.render('reports/index', { groups: grouped() });
});

function display(column, value) {
  if (value === null || value === undefined || value === '') return '';
  switch (column.type) {
    case 'money': return format.money(value);
    case 'number': return format.number(value);
    case 'percent': return format.percent(value);
    case 'date': return format.date(value);
    case 'datetime': return format.dateTime(value);
    default: return String(value);
  }
}

const show = handle(async (req, res) => {
  const report = reports[req.params.key];
  if (!report) throw notFound('That report does not exist.');
  const filters = readFilters(req.query, report);
  const { rows, totals } = await run(req.params.key, filters);
  const exportFormat = req.query.format;
  if (exportFormat === 'csv' || exportFormat === 'print') {
    if (!req.can('reports.export')) throw forbidden('You do not have permission to export reports.');
    await audit.log(null, req, {
      action: 'export', module: 'Reports', recordId: req.params.key,
      description: `Exported "${report.title}" as ${exportFormat === 'csv' ? 'CSV (Excel)' : 'print/PDF'} (${rows.length} rows).`
    });
  }
  if (exportFormat === 'csv') {
    return sendCsv(res, `${req.params.key}-${new Date().toISOString().slice(0, 10)}.csv`,
      report.columns.map((column) => ({ label: column.label, value: (row) => row[column.key] })), rows);
  }
  res.render(exportFormat === 'print' ? 'reports/print' : 'reports/show', {
    key: req.params.key, report, rows, totals, filters, display,
    organization: await settings.get('organization_name'), generatedAt: new Date().toLocaleString('en-PH')
  });
});

module.exports = { index, show };
