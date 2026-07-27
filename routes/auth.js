
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const wrapAsync = require('../utils/wrapAsync');

router.post('/google-login', wrapAsync(authController.googleLogin));
router.post('/validate-referral', wrapAsync(authController.validateReferral));
router.post('/register', wrapAsync(authController.register));
router.get('/me', authMiddleware, wrapAsync(authController.getMe));
router.post('/track-usage', authMiddleware, wrapAsync(authController.trackUsage));
router.post('/logout', authMiddleware, wrapAsync(authController.logout));

module.exports = router;
