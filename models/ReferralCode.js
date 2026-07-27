const mongoose = require('mongoose');

const referralCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  planTier: { type: String, enum: ['free', 'pro', 'premium'], default: 'free' },
  isUsed: { type: Boolean, default: false },
  usageCount: { type: Number, default: 0 },
  usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ReferralCode', referralCodeSchema);
