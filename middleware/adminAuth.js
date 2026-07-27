// ============================================
// CoBox - Admin Auth Middleware
// ============================================
const bcrypt = require('bcryptjs');

async function adminAuthMiddleware(req, res, next) {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey) {
      return res.status(401).json({ error: 'Admin key required' });
    }

    const storedHash = process.env.ADMIN_PASSWORD_HASH;
    if (!storedHash) {
      return res.status(500).json({ error: 'Admin password not configured. Run: npm run setup-admin' });
    }

    const valid = await bcrypt.compare(adminKey, storedHash);
    if (!valid) {
      return res.status(403).json({ error: 'Invalid admin credentials' });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = adminAuthMiddleware;
