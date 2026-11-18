/**
 * Assigns a readable, unique document number derived from the row's primary key
 * (e.g. PR-2026-00042). Must be called inside the transaction that inserted the
 * row; the column has a UNIQUE index so collisions are impossible.
 */
async function assignDocumentNumber(connection, { table, column, prefix, id }) {
  const year = new Date().getFullYear();
  const number = `${prefix}-${year}-${String(id).padStart(5, '0')}`;
  await connection.execute(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [number, id]);
  return number;
}

function temporaryNumber(prefix) {
  return `${prefix}-TMP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 30);
}

module.exports = { assignDocumentNumber, temporaryNumber };
