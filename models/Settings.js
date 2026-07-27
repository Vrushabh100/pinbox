const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
});

// Uses the default mongoose connection (pinboxx DB via MONGODB_URI)
module.exports = mongoose.model('Settings', settingsSchema);
