const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const authMiddleware = require('../middleware/auth');

// Settings are public UI config (like background images) — no auth required
router.get('/', async (req, res) => {
  try {
    const settings = await Settings.find({});
    const settingsObj = {};
    settings.forEach(s => {
      settingsObj[s.key] = s.value;
    });
    res.json(settingsObj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

