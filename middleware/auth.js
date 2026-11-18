const { forbidden } = require('../lib/http');

const publicPaths = ['/login', '/register', '/setup', '/health'];

/** Redirects anonymous visitors to the sign-in page for every protected route. */
function requireAuth(req, res, next) {
  if (publicPaths.includes(req.path)) return next();
  if (!req.user) {
    if (req.method === 'GET') {
      const target = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login${req.originalUrl === '/' ? '' : `?next=${target}`}`);
    }
    return res.status(401).render('error', {
      title: 'Session expired',
      message: 'Your session has ended. Sign in again to continue.'
    });
  }
  if (req.user.mustChangePassword && !['/account/password', '/logout'].includes(req.path)) {
    return res.redirect('/account/password');
  }
  next();
}

/** Allows the request when the user holds ANY of the listed permissions. */
function requirePermission(...keys) {
  return (req, res, next) => {
    if (req.can && req.can(...keys)) return next();
    next(forbidden());
  };
}

module.exports = { requireAuth, requirePermission };
