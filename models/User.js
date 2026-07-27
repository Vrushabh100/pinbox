// ============================================
// CoBox - User Model
// ============================================
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const actionHistorySchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['warn', 'suspend', 'ban', 'reinstate'],
    required: true
  },
  reason: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  adminAction: { type: Boolean, default: true },
  duration: { type: Number, default: null } // hours
}, { _id: false });

const usageSchema = new mongoose.Schema({
  emailsGenerated: { type: Number, default: 0 },
  otpRetrieved:    { type: Number, default: 0 },
  apiRequests:     { type: Number, default: 0 },
  accountsCreated: { type: Number, default: 0 },
  lastResetDate:   { type: String, default: '' }
}, { _id: false });

const userSchema = new mongoose.Schema({
  username:      { type: String, required: true, trim: true, unique: true },
  fullName:      { type: String, default: '' },
  email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
  mobile:        { type: String, default: '' },
  age:           { type: String, default: '' },
  purpose:       { type: String, default: '' },
  authProvider:  { type: String, default: 'manual' }, // 'google', 'github', 'manual'
  googleSubject: { type: String, default: '' },
  plan:          { type: String, enum: ['free', 'pro', 'premium'], default: 'free' },
  planExpiresAt: { type: Date, default: null },
  lastActive:    { type: Date, default: Date.now },

  // Admin-controlled status
  status:        { type: String, enum: ['active', 'warned', 'suspended', 'banned'], default: 'active' },
  warnings:      { type: Number, default: 0 },
  suspendedUntil:{ type: Date, default: null },
  actionHistory: [actionHistorySchema],

  // Track the referral code used to register
  referralCode:  { type: String, default: null },

  // Usage tracking
  usage: { type: usageSchema, default: () => ({}) },

  // Timestamps
  lastLogin:  { type: Date, default: null },
  lastActive: { type: Date, default: null },
}, {
  timestamps: true // adds createdAt and updatedAt
});

// Check if user is currently restricted
userSchema.methods.isRestricted = function () {
  if (this.status === 'banned') return { restricted: true, reason: 'banned', message: 'Your account has been permanently banned.' };

  if (this.status === 'suspended' && this.suspendedUntil) {
    if (new Date(this.suspendedUntil) > new Date()) {
      return {
        restricted: true,
        reason: 'suspended',
        message: `Your account is suspended until ${new Date(this.suspendedUntil).toLocaleString()}.`,
        until: this.suspendedUntil
      };
    } else {
      // Auto-reinstate
      this.status = 'active';
      this.suspendedUntil = null;
      this.save();
    }
  }

  return { restricted: false };
};

// Reset daily usage counters
userSchema.methods.resetDailyUsageIfNeeded = function () {
  const today = new Date().toDateString();
  if (this.usage.lastResetDate !== today) {
    this.usage.emailsGenerated = 0;
    this.usage.vaultMailUsed = 0;
    this.usage.apiRequests = 0;
    this.usage.lastResetDate = today;
  }
};

module.exports = mongoose.model('User', userSchema);
