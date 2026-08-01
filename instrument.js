require('dotenv').config(); // Load env first
const Sentry = require("@sentry/node");

// Initialize Sentry unconditionally since we have the DSN
Sentry.init({
  dsn: process.env.SENTRY_DSN || "https://0d8175268870351f969a55ac4d729e45@o4511807151800320.ingest.de.sentry.io/4511807187648592",
  // Performance Monitoring
  tracesSampleRate: 1.0, // Capture 100% of the transactions
  dataCollection: {
    // userInfo: false,
  },
});
