const { pool } = require('../lib/db');

const defaults = {
  organization_name: 'Mindoro Tech Hardware & BuildSupply Corp.',
  requisition_approval_levels: '1',
  po_approval_levels: '1',
  allow_self_approval: '0',
  default_tax_rate: '12',
  budget_warning_threshold: '80',
  budget_overrun_policy: 'block',
  upcoming_delivery_days: '7',
  session_idle_minutes: '30',
  self_registration: 'approval',
  self_registration_role: 'department_requester'
};

const validators = {
  organization_name: (v) => v.length >= 2 && v.length <= 255,
  requisition_approval_levels: (v) => ['1', '2', '3'].includes(v),
  po_approval_levels: (v) => ['1', '2', '3'].includes(v),
  allow_self_approval: (v) => ['0', '1'].includes(v),
  default_tax_rate: (v) => /^\d{1,2}(\.\d{1,2})?$/.test(v),
  budget_warning_threshold: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 100,
  budget_overrun_policy: (v) => ['block', 'warn'].includes(v),
  upcoming_delivery_days: (v) => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 60,
  session_idle_minutes: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 5 && Number(v) <= 480,
  self_registration: (v) => ['approval', 'open', 'disabled'].includes(v),
  self_registration_role: (v) => /^[a-z0-9_]{1,64}$/.test(v) && v !== 'super_admin'
};

let cache = null;
let cacheTime = 0;

async function all(connection = pool()) {
  const [rows] = await connection.query('SELECT * FROM settings ORDER BY setting_key');
  return rows;
}

async function load(connection = pool()) {
  if (cache && Date.now() - cacheTime < 30000) return cache;
  const values = { ...defaults };
  for (const row of await all(connection)) values[row.setting_key] = row.setting_value;
  cache = values;
  cacheTime = Date.now();
  return values;
}

async function get(key, connection) {
  const values = await load(connection);
  return values[key] === undefined ? defaults[key] : values[key];
}

async function getNumber(key, connection) {
  return Number(await get(key, connection));
}

function clearCache() {
  cache = null;
}

module.exports = { all, load, get, getNumber, clearCache, validators, defaults };
