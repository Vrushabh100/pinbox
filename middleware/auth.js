// ============================================
// CoBox - JWT Auth Middleware
// ============================================
const jwt = require('jsonwebtoken');
const User = require('../models/User');

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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
