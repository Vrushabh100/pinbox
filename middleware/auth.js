// ============================================
// Pinboxx - JWT Auth Middleware
// Reads token from HttpOnly cookie (pb_token) first,
// falls back to Authorization: Bearer for backward compatibility.
// ============================================
const jwt = require('jsonwebtoken');
const User = require('../models/User');

async function authMiddleware(req, res, next) {
  try {
    // 1. Prefer HttpOnly cookie
    let token = req.cookies?.pb_token;

    // 2. Fallback: Authorization header (for older clients / API consumers)
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Auto-reinstate suspended users if time has passed
    if (user.status === 'suspended' && user.suspendedUntil) {
      if (new Date(user.suspendedUntil) <= new Date()) {
        user.status = 'active';
        user.suspendedUntil = null;
        await user.save();
      }
    }

    // Auto-downgrade expired plans
    if (['pro', 'premium'].includes(user.plan) && user.planExpiresAt && new Date(user.planExpiresAt) <= new Date()) {
      user.plan = 'free';
      await user.save();
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(err);
  }
}

module.exports = authMiddleware;
