const express = require('express');
const ReferralCode = require('../models/ReferralCode');

const router = express.Router();

// Generate a new unique code function
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'TEAM-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ─── POST /api/admin/referrals ───────────────────────────────────────────────
// Admin generates a new code
router.post('/', async (req, res) => {
  try {
    let newCode;
    let exists = true;
    while (exists) {
      newCode = generateCode();
      const existing = await ReferralCode.findOne({ code: newCode });
      if (!existing) exists = false;
    }
    
    const referral = new ReferralCode({ code: newCode });
    await referral.save();
    
    res.json(referral);
  } catch (err) {
    console.error('Error generating referral code:', err);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// ─── GET /api/admin/referrals ────────────────────────────────────────────────
// Admin gets list of all codes (populates usedBy username)
router.get('/', async (req, res) => {
  try {
    const codes = await ReferralCode.find().populate('usedBy', 'username email').sort({ createdAt: -1 });
    res.json(codes);
  } catch (err) {
    console.error('Error fetching referral codes:', err);
    res.status(500).json({ error: 'Failed to fetch codes' });
  }
});

// ─── DELETE /api/admin/referrals/:id ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await ReferralCode.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting referral code:', err);
    res.status(500).json({ error: 'Failed to delete code' });
  }
});

module.exports = router;
