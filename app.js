require('./instrument.js'); // Sentry initialization
if (process.env.NODE_ENV !== "production") {
  require('dotenv').config();
}
const express = require('express');
const Sentry = require('@sentry/node');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const connectDB = require('./db');

const authRoutes    = require('./routes/auth');
const adminRoutes   = require('./routes/admin');
const tempmailRouter = require('./routes/tempmail');
const paymentRouter  = require('./routes/payment');
const settingsRoutes = require('./routes/settings');

const app = express();
const PORT = process.env.PORT || 3000;

// Enforce HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect('https://' + req.headers.host + req.url);
  }
  next();
});

app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', process.env.COBOX_ADMIN_ORIGIN || ''],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve Public Config (e.g. Google Client ID) so it's not hardcoded in HTML
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID
  });
});

// Rate limiting for tempmail endpoints
const tempmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 150, // limit each IP to 150 requests per windowMs
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' }
});

// API routes
app.use('/api/auth',     authRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/tempmail', tempmailLimiter, tempmailRouter);
app.use('/api/payment',  paymentRouter);
app.use('/api/settings', settingsRoutes);

// Frontend routes — all serve the same SPA shell
// '/' is the Google OAuth redirect target (no path = allowed by Google Console)
app.get(['/', '/home', '/logout', '/landingpage'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Catch-all route to serve the main HTML file for SPAs
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// The error handler must be registered before any other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', sentry: res.sentry });
});

// Start server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(` Pinboxx running at http://localhost:${PORT}`);
  });
});
