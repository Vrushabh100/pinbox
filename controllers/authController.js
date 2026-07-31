// ============================================
// Pinboxx - Auth Controller
// ============================================
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const ReferralCode = require('../models/ReferralCode');
const { encrypt } = require('../utils/encryption');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ─── Cookie Options ──────────────────────────────────────────────────────────
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie('pb_token', token, COOKIE_OPTS);
}

function buildUserPayload(user) {
  return {
    id: user._id,
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    mobile: user.mobile,
    age: user.age,
    purpose: user.purpose,
    authProvider: user.authProvider,
    plan: user.plan,
    status: user.status,
    warnings: user.warnings,
    suspendedUntil: user.suspendedUntil,
    createdAt: user.createdAt,
  };
}

// ─── Google Login (Phase 1: verify id_token server-side) ────────────────────
module.exports.googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Google ID token required' });

    // Strict server-side verification — no client-supplied email trusted
    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
    } catch (e) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const payload = ticket.getPayload();
    const email = payload.email?.toLowerCase();
    if (!email) return res.status(400).json({ error: 'No email in token' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found. Please register first.' });

    user.lastLogin = new Date();
    user.lastActive = new Date();
    await user.save();

    const token = generateToken(user._id);
    setAuthCookie(res, token);

    // Also return token in body for backward-compat with older clients
    res.json({ token, user: buildUserPayload(user) });
  } catch (err) {
    console.error('Google login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
};

// ─── Validate Referral ────────────────────────────────────────────────────────
module.exports.validateReferral = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Referral code is required' });

    const referral = await ReferralCode.findOne({ code: code.toUpperCase() });
    if (!referral) return res.status(404).json({ error: 'Invalid referral code' });

    res.json({ valid: true });
  } catch (err) {
    console.error('Validate referral error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── Register ─────────────────────────────────────────────────────────────────
module.exports.register = async (req, res) => {
  try {
    const { username, fullName, email, mobile, age, purpose, authProvider, googleSubject, referralCode, idToken } = req.body;

    if (!username || !email || !mobile || !authProvider) {
      return res.status(400).json({ error: 'Missing required fields: username, email, mobile, authProvider' });
    }

    // Verify Google token if registering via Google
    if (authProvider === 'google') {
      if (!idToken) return res.status(400).json({ error: 'Google ID token required for Google registration' });
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (payload.email?.toLowerCase() !== email.toLowerCase()) {
          return res.status(401).json({ error: 'Email does not match Google token' });
        }
      } catch (e) {
        return res.status(401).json({ error: 'Invalid Google token' });
      }
    }

    let validatedReferral = null;
    if (authProvider === 'referral') {
      if (!referralCode) return res.status(400).json({ error: 'Referral code is required for team login' });
      validatedReferral = await ReferralCode.findOne({ code: referralCode.toUpperCase() });
      if (!validatedReferral) return res.status(404).json({ error: 'Invalid referral code' });
    }

    // FIX ReDoS: escape special regex characters in username before using in RegExp
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existingUsername = await User.findOne({ username: { $regex: new RegExp('^' + escapedUsername + '$', 'i') } });
    if (existingUsername && existingUsername.email !== email.toLowerCase()) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      user = new User({
        username,
        fullName: fullName || '',
        email: email.toLowerCase(),
        mobile: process.env.ENCRYPTION_KEY ? encrypt(mobile) : mobile,
        age: age || '',
        purpose: process.env.ENCRYPTION_KEY ? encrypt(purpose || '') : (purpose || ''),
        authProvider,
        googleSubject: googleSubject || '',
        status: 'active',
        lastLogin: new Date(),
        lastActive: new Date(),
      });
    } else {
      user.username = username;
      if (fullName) user.fullName = fullName;
      user.mobile = process.env.ENCRYPTION_KEY ? encrypt(mobile) : mobile;
      user.age = age || user.age;
      user.purpose = process.env.ENCRYPTION_KEY ? encrypt(purpose || user.purpose) : (purpose || user.purpose);
      user.authProvider = authProvider;
      user.googleSubject = googleSubject || user.googleSubject;
      user.lastLogin = new Date();
      user.lastActive = new Date();
    }

    if (validatedReferral) {
      user.plan = validatedReferral.planTier || 'free';
      user.referralCode = validatedReferral.code;
      if (['pro', 'premium'].includes(user.plan)) {
        const expires = new Date();
        expires.setDate(expires.getDate() + 30);
        user.planExpiresAt = expires;
      }
    }

    await user.save();

    if (validatedReferral) {
      validatedReferral.isUsed = true;
      validatedReferral.usageCount = (validatedReferral.usageCount || 0) + 1;
      if (!validatedReferral.usedBy) validatedReferral.usedBy = user._id;
      await validatedReferral.save();
    }

    const token = generateToken(user._id);
    setAuthCookie(res, token);

    res.json({ token, user: buildUserPayload(user) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Email already registered' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
};

// ─── Get Me ───────────────────────────────────────────────────────────────────
module.exports.getMe = async (req, res) => {
  const user = req.user;
  user.lastActive = new Date();
  await user.save();

  const restriction = user.isRestricted();
  res.json({
    ...buildUserPayload(user),
    restriction,
    latestAction: user.actionHistory.length > 0 ? user.actionHistory[user.actionHistory.length - 1] : null,
    usage: user.usage,
  });
};

// ─── Track Usage ──────────────────────────────────────────────────────────────
module.exports.trackUsage = async (req, res) => {
  try {
    const { metric } = req.body;
    if (!['email', 'api'].includes(metric)) {
      return res.status(400).json({ error: 'Invalid metric type' });
    }
    const updateField = metric === 'email' ? 'usage.emailsGenerated' : 'usage.apiRequests';
    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { $inc: { [updateField]: 1 } },
      { new: true }
    );
    if (!updatedUser) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, usage: updatedUser.usage });
  } catch (err) {
    console.error('Track usage error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─── Logout (clear HttpOnly cookie) ──────────────────────────────────────────
module.exports.logout = async (req, res) => {
  res.clearCookie('pb_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
  });
  res.json({ success: true, message: 'Logged out' });
};
