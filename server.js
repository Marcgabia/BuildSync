const path = require('node:path');
const express = require('express');
const db = require('./database');
const { migrate } = require('./migrations/runner');
const { csrfProtection } = require('./middleware/csrf');
const { sessionMiddleware } = require('./middleware/session');
const { requireAuth } = require('./middleware/auth');
const { HttpError } = require('./lib/http');
const { ValidationError } = require('./lib/validate');
const format = require('./lib/format');
const notifications = require('./services/notifications');
const alerts = require('./services/alerts');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY);
}
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 2000 }));
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"
  );
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Light/dark preference saved by the theme toggle; rendered server-side to avoid a flash.
app.use((req, res, next) => {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)buildsync_theme=(light|dark)(?:;|$)/);
  res.locals.theme = match ? match[1] : null;
  next();
});

app.get('/health', async (req, res, next) => {
  try {
    const pool = db.getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
});

app.use(csrfProtection);
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.locals.format = format;
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.unreadCount = 0;
  if (!req.user || req.method !== 'GET') return next();
  notifications.unreadCount(req.user.id)
    .then((count) => { res.locals.unreadCount = count; next(); })
    .catch(next);
});

app.use('/', require('./routes/auth'));
app.use(requireAuth);
app.use('/', require('./routes/dashboard'));
app.use('/suppliers', require('./routes/suppliers'));
app.use('/products', require('./routes/products'));
app.use('/inventory', require('./routes/inventory'));
app.use('/requisitions', require('./routes/requisitions'));
app.use('/approvals', require('./routes/approvals'));
app.use('/purchase-orders', require('./routes/purchaseOrders'));
app.use('/deliveries', require('./routes/deliveries'));
app.use('/budgets', require('./routes/budgets'));
app.use('/reports', require('./routes/reports'));
app.use('/notifications', require('./routes/notifications'));
app.use('/activity-logs', require('./routes/activityLogs'));
app.use('/', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found',
    message: 'The page you are looking for does not exist.'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError || error instanceof ValidationError) {
    const titles = { 400: 'Request could not be completed', 403: 'Access denied', 404: 'Page not found', 409: 'Conflict' };
    return res.status(error.status).render('error', {
      title: titles[error.status] || 'Request could not be completed',
      message: error.message
    });
  }
  console.error('Request failed:', error);
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: 'The request could not be completed. Please try again.'
  });
});

async function startServer() {
  await db.initializeDatabase();
  await migrate();
  alerts.start();
  const server = app.listen(port, host, () => {
    console.log(`BuildSync is listening on http://${host}:${port}.`);
  });

  const shutdown = () => {
    server.close(async (error) => {
      try {
        await db.getPool().end();
      } catch (shutdownError) {
        console.warn('Database shutdown warning:', shutdownError.message);
      }
      if (error) {
        console.error('Server shutdown failed:', error);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  startServer().catch(async (error) => {
    console.error('BuildSync could not start:', error);
    try {
      if (db.getPool) {
        await db.getPool().end();
      }
    } catch (shutdownError) {
      console.warn('Database shutdown warning:', shutdownError.message);
    }
    process.exitCode = 1;
  });
}

module.exports = { app, startServer };
