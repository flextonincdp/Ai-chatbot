const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// This prototype has shared login credentials, so the client cannot supply a
// durable user or organization identity.  Give every authenticated session a
// server-generated identity instead.  Chat, conversation, and artifact
// authorization can then scope records to this session rather than collapsing
// all callers into the anonymous fallback identity.
const DEFAULT_ORGANIZATION_ID = process.env.DEFAULT_ORGANIZATION_ID || 'org_default';

function ensureTrustedSessionUser(session) {
  if (!session.user || typeof session.user !== 'object') {
    session.user = {};
  }

  // Preserve an identity already assigned to this server-side session.  Never
  // read either value from the login request body.
  if (typeof session.user.id !== 'string' || !session.user.id.trim()) {
    session.user.id = crypto.randomUUID();
  }
  if (typeof session.user.organizationId !== 'string' || !session.user.organizationId.trim()) {
    session.user.organizationId = DEFAULT_ORGANIZATION_ID;
  }

  return session.user;
}

// POST /api/login  { role: 'admin'|'user', username?, password?, code? }
router.post('/login', (req, res) => {
  const { role, username, password, code } = req.body || {};

  if (role === 'admin') {
    const okUser = username === process.env.ADMIN_USERNAME;
    const okPass = password === process.env.ADMIN_PASSWORD;
    if (okUser && okPass) {
      ensureTrustedSessionUser(req.session);
      req.session.role = 'admin';
      req.session.name = username;
      return res.json({ ok: true, role: 'admin', redirect: '/admin.html' });
    }
    return res.status(401).json({ error: 'Invalid admin username or password' });
  }

  if (role === 'user') {
    const required = process.env.USER_ACCESS_CODE || '';
    if (!required || code === required) {
      ensureTrustedSessionUser(req.session);
      req.session.role = 'user';
      req.session.name = 'Employee';
      return res.json({ ok: true, role: 'user', redirect: '/chat.html' });
    }
    return res.status(401).json({ error: 'Invalid access code' });
  }

  return res.status(400).json({ error: 'role must be "admin" or "user"' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/whoami', (req, res) => {
  if (!req.session || !req.session.role) return res.json({ role: null });
  res.json({ role: req.session.role, name: req.session.name || null });
});

module.exports = router;
