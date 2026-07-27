require('dotenv').config(); // Load env first
const Sentry = require("@sentry/node");

// Only initialize if not in a local dev environment (optional, but good practice)
if (process.env.NODE_ENV === "production" || process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN || "https://0d8175268870351f969a55ac4d729e45@o4511807151800320.ingest.de.sentry.io/4511807187648592",
    dataCollection: {
      // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
      // https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#dataCollection
      // userInfo: false,
      // httpBodies: [],
    },
  });
}
