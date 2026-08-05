// ============================================
// Pinboxx - Rate Limiters
// ============================================
const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV !== 'production';
const passThrough = (req, res, next) => next();

// Auth: 10 requests per 15 minutes (login/register brute force protection)
const authLimiter = isDev ? passThrough : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Payment: 5 requests per hour
const paymentLimiter = isDev ? passThrough : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many payment requests, please try again after an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API: 200 requests per 15 minutes
const apiLimiter = isDev ? passThrough : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin: 5 requests per 15 minutes (brute-force protection for bcrypt key check)
const adminLimiter = isDev ? passThrough : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many admin auth attempts, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, paymentLimiter, apiLimiter, adminLimiter };
