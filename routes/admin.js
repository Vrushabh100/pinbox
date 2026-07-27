
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuthMiddleware = require('../middleware/adminAuth');
const referralRoutes = require('./referrals');
const wrapAsync = require('../utils/wrapAsync');

router.use(adminAuthMiddleware);
router.use('/referrals', referralRoutes);

router.post('/verify', adminController.verify);
router.get('/stats', wrapAsync(adminController.getStats));
router.get('/users', wrapAsync(adminController.getUsers));
router.get('/users/:id', wrapAsync(adminController.getUserById));
router.post('/users/:id/action', wrapAsync(adminController.performAction));
router.patch('/users/:id/plan', wrapAsync(adminController.updatePlan));

module.exports = router;
