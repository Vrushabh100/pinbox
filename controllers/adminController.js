
const User = require('../models/User');

module.exports.verify = (req, res) => {
  res.json({ success: true, message: 'Admin authenticated' });
};

module.exports.getStats = async (req, res) => {
  try {
    const [totalUsers, bannedUsers, suspendedUsers, warnedUsers] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ status: 'banned' }),
      User.countDocuments({ status: 'suspended' }),
      User.countDocuments({ status: 'warned' })
    ]);

    res.json({
      users: { total: totalUsers, banned: bannedUsers, suspended: suspendedUsers, warned: warnedUsers }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports.getUsers = async (req, res) => {
  try {
    const { search = '', status = '' } = req.query;
    const query = {};

    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { mobile: { $regex: search, $options: 'i' } }
      ];
    }

    if (status) query.status = status;

    const users = await User.find(query).sort({ createdAt: -1 }).lean();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports.performAction = async (req, res) => {
  try {
    const { action, reason, duration } = req.body;

    if (!action || !reason) {
      return res.status(400).json({ error: 'action and reason are required' });
    }

    if (!['warn', 'suspend', 'ban', 'reinstate'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Must be: warn, suspend, ban, reinstate' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.actionHistory.push({
      action,
      reason,
      timestamp: new Date(),
      adminAction: true,
      duration: duration || null
    });

    if (action === 'warn') {
      user.status = 'warned';
      user.warnings = (user.warnings || 0) + 1;
    } else if (action === 'suspend') {
      user.status = 'suspended';
      const hours = duration || 24;
      user.suspendedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    } else if (action === 'ban') {
      user.status = 'banned';
      user.suspendedUntil = null;
    } else if (action === 'reinstate') {
      user.status = 'active';
      user.suspendedUntil = null;
      user.warnings = 0;
    }

    await user.save();

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        status: user.status,
        warnings: user.warnings,
        suspendedUntil: user.suspendedUntil,
        actionHistory: user.actionHistory
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports.updatePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['free', 'pro', 'premium'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Must be free, pro, or premium.' });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { plan },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, plan: user.plan, userId: user._id, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
