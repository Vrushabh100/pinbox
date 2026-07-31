require('./instrument.js'); // Sentry initialization
if (process.env.NODE_ENV !== "production") {
  require('dotenv').config();
}
const express = require('express');
const Sentry = require('@sentry/node');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const connectDB = require('./db');
const { authLimiter, paymentLimiter } = require('./middleware/rateLimiter');

const authRoutes     = require('./routes/auth');
const adminRoutes    = require('./routes/admin');
const tempmailRouter = require('./routes/tempmail');
const paymentRouter  = require('./routes/payment');
const settingsRoutes = require('./routes/settings');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ─── Enforce HTTPS in production ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (
    process.env.NODE_ENV === 'production' &&
    req.headers['x-forwarded-proto'] &&
    req.headers['x-forwarded-proto'] !== 'https'
  ) {
    return res.redirect('https://' + req.headers.host + req.url);
  }
  next();
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_ORIGIN,
  process.env.COBOX_ADMIN_ORIGIN,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

// ─── Body + Cookie Parsers ───────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Public Config ────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID });
});

// ─── Tempmail Rate Limiter (keep existing) ───────────────────────────────────
const tempmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',     authLimiter,     authRoutes);
app.use('/api/admin',                     adminRoutes);
app.use('/api/tempmail', tempmailLimiter, tempmailRouter);
app.use('/api/payment',  paymentLimiter,  paymentRouter);
app.use('/api/settings',                  settingsRoutes);

// ─── Frontend SPA ─────────────────────────────────────────────────────────────
app.get(['/', '/home', '/logout', '/landingpage'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Sentry + Error Handling ─────────────────────────────────────────────────
Sentry.setupExpressErrorHandler(app);
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', sentry: res.sentry });
});

// ─── Start ────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Pinboxx running at http://localhost:${PORT}`);
  });
});
