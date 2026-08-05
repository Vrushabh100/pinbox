// ============================================
// Pinboxx - TempAddress Model
// Tracks which temp-mail address belongs to which user.
// Used to enforce ownership on GET /messages (prevents IDOR).
// Records expire after 24 hours via MongoDB TTL index.
// ============================================
const mongoose = require('mongoose');

const tempAddressSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User', index: true },
  address: { type: String, required: true, lowercase: true, trim: true },
  createdAt: { type: Date, default: Date.now, expires: '24h' }, // auto-deleted after 24h
});

// Compound index for fast ownership lookups: does this userId own this address?
tempAddressSchema.index({ address: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('TempAddress', tempAddressSchema);
