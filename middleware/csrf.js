const { randomBytes, timingSafeEqual } = require('node:crypto');

const cookieName = 'buildsync_csrf';
const tokenPattern = /^[a-f0-9]{64}$/;

function readCookie(header, name) {
  const pair = String(header || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!pair) return '';
  return pair.slice(name.length + 1);
}

function csrfProtection(req, res, next) {
  let token = readCookie(req.headers.cookie, cookieName);
  if (!tokenPattern.test(token)) {
    token = randomBytes(32).toString('hex');
    const secure = req.secure ? '; Secure' : '';
    res.append(
      'Set-Cookie',
      `${cookieName}=${token}; Path=/; SameSite=Lax; HttpOnly${secure}`
    );
  }
  res.locals.csrfToken = token;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Multipart bodies are parsed later by the upload handler, so multipart forms
  // carry the token in the action URL instead.
  const isMultipart = String(req.get('content-type') || '').toLowerCase().startsWith('multipart/form-data');
  const submitted = String(
    (req.body && req.body._csrf) || req.get('x-csrf-token') ||
      (isMultipart && req.query && req.query._csrf) || ''
  );
  if (!tokenPattern.test(submitted) || submitted.length !== token.length ||
      !timingSafeEqual(Buffer.from(submitted), Buffer.from(token))) {
    return res.status(403).render('error', {
      title: 'Request could not be verified',
      message: 'Reload the page and submit the form again.'
    });
  }

  next();
}

module.exports = { csrfProtection, cookieName };
