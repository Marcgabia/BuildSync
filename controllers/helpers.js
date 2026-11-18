const { handle, isUserError, safeRedirectPath } = require('../lib/http');

function backPath(req, fallback) {
  try {
    const referer = new URL(req.get('referer') || '');
    if (referer.host !== req.get('host')) return fallback;
    return safeRedirectPath(referer.pathname + referer.search, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Wraps a state-changing action: on success flashes `success` and redirects; on a
 * validation/permission error flashes the message and redirects back, so forms
 * and buttons always give feedback instead of failing silently.
 */
function action(fn, { success, redirect }) {
  return handle(async (req, res) => {
    const fallback = typeof redirect === 'function' ? redirect(req) : redirect;
    try {
      const result = await fn(req, res);
      if (res.headersSent) return;
      const message = typeof success === 'function' ? success(result, req) : success;
      if (message) await req.flash('success', message);
      if (result && result.warning) await req.flash('warning', `${message ? `${message} ` : ''}${result.warning}`);
      const target = result && result.redirect ? result.redirect : fallback;
      res.redirect(safeRedirectPath(target, '/'));
    } catch (error) {
      if (!isUserError(error) || error.status === 404) throw error;
      await req.flash('error', error.message);
      res.redirect(backPath(req, fallback));
    }
  });
}

module.exports = { action, backPath };
