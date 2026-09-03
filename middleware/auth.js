// Two roles only:
//  - "admin": can upload / delete / see the full knowledge base
//  - "user":  can chat with the grounded assistant and export confirmed answers
// Both are simple shared-credential logins (see .env) — no per-person accounts,
// which keeps this prototype easy to run for a small team. Swap in a real user
// table + password hashing before using this with a large or external audience.

// NOTE: req.path is relative to the router's mount point, so it does NOT
// include the "/api/..." prefix when this middleware runs inside a sub-router
// (e.g. routes/admin.js mounted at /api/admin). req.originalUrl always has
// the full path, which is what we need to tell an API call apart from a
// plain page navigation (like GET /admin.html).
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Admin login required' });
  return res.redirect('/login.html');
}

function requireUser(req, res, next) {
  if (req.session && (req.session.role === 'user' || req.session.role === 'admin')) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  return res.redirect('/login.html');
}

module.exports = { requireAdmin, requireUser };
