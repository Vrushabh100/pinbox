
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ReferralCode = require('../models/ReferralCode');

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

module.exports.googleLogin = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update last login
    user.lastLogin = new Date();
    user.lastActive = new Date();
    await user.save();

    const token = generateToken(user._id);
    res.json({
      token,
      user: {
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
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error('Google login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
};

module.exports.validateReferral = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Referral code is required' });

    const referral = await ReferralCode.findOne({ code: code.toUpperCase() });
    if (!referral) {
      return res.status(404).json({ error: 'Invalid referral code' });
    }

    res.json({ valid: true });
  } catch (err) {
    console.error('Validate referral error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports.register = async (req, res) => {
  try {
    const { username, fullName, email, mobile, age, purpose, authProvider, googleSubject, referralCode } = req.body;

    if (!username || !email || !mobile || !authProvider) {
      return res.status(400).json({ error: 'Missing required fields: username, email, mobile, authProvider' });
    }
    
    let validatedReferral = null;
    if (authProvider === 'referral') {
      if (!referralCode) return res.status(400).json({ error: 'Referral code is required for team login' });
      validatedReferral = await ReferralCode.findOne({ code: referralCode.toUpperCase() });
      if (!validatedReferral) return res.status(404).json({ error: 'Invalid referral code' });
    }

    const existingUsername = await User.findOne({ username: { $regex: new RegExp('^' + username + '$', 'i') } });
    if (existingUsername && existingUsername.email !== email.toLowerCase()) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      user = new User({
        username,
        fullName: fullName || '',
        email: email.toLowerCase(),
        mobile,
        age: age || '',
        purpose: purpose || '',
        authProvider,
        googleSubject: googleSubject || '',
        status: 'active',
        lastLogin: new Date(),
        lastActive: new Date()
      });
    } else {
      user.username = username;
      if (fullName) user.fullName = fullName;
      user.mobile = mobile;
      user.age = age || user.age;
      user.purpose = purpose || user.purpose;
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
      if (!validatedReferral.usedBy) {
        validatedReferral.usedBy = user._id;
      }
      await validatedReferral.save();
    }

    const token = generateToken(user._id);

    res.json({
      token,
      user: {
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
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
};

module.exports.getMe = async (req, res) => {
  const user = req.user;

  user.lastActive = new Date();
  await user.save();

  const restriction = user.isRestricted();

  res.json({
    id: user._id,
    username: user.username,
    email: user.email,
    mobile: user.mobile,
    age: user.age,
    purpose: user.purpose,
    authProvider: user.authProvider,
    plan: user.plan,
    status: user.status,
    warnings: user.warnings,
    suspendedUntil: user.suspendedUntil,
    restriction,
    latestAction: user.actionHistory.length > 0 ? user.actionHistory[user.actionHistory.length - 1] : null,
    usage: user.usage,
    createdAt: user.createdAt
  });
};

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
    
    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ success: true, usage: updatedUser.usage });
  } catch (err) {
    console.error('Track usage error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports.logout = async (req, res) => {
  res.json({ success: true, message: 'Logged out' });
};
