// ============================================
// Pinboxx - Razorpay Payment Routes
// KEY_SECRET stays server-side ONLY.
// ============================================
const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const Sentry = require('@sentry/node');

// PLAN PRICES (Server-Side Truth)
const PLAN_PRICES = {
  pro: 299,
  premium: 599
};

// ============================================
// WEBHOOK (No Auth required)
// ============================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    
    if (!keySecret || !signature) return res.status(400).send('Missing signature or secret');

    const isValid = Razorpay.validateWebhookSignature(req.body.toString(), signature, keySecret);
    if (!isValid) return res.status(400).send('Invalid signature');

    const event = JSON.parse(req.body.toString());
    
    if (event.event === 'payment.captured') {
      const { notes } = event.payload.payment.entity;
      if (notes && notes.userId) {
        const user = await User.findById(notes.userId);
        if (user) {
          const selectedPlan = notes.plan || 'pro';
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 30);
          user.plan = selectedPlan;
          user.planExpiresAt = expiresAt;
          await user.save();
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    next(err); // Pass to Sentry
  }
});

// All subsequent payment routes require a valid JWT
router.use(express.json()); // Webhook used raw, now re-enable JSON parsing
router.use(authMiddleware);

// Validate env vars and return a Razorpay instance
function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || keyId === 'dummy_id') {
    throw new Error('Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

// POST /api/payment/create-order
// Body: { currency?, plan? }
// Returns: { order_id, amount, currency, key_id }
router.post('/create-order', async (req, res, next) => {
  try {
    const { currency = 'INR', plan = 'pro' } = req.body;

    const price = PLAN_PRICES[plan];
    if (!price) {
      return res.status(400).json({ error: 'Invalid plan selected.' });
    }

    const amountPaise = price * 100;

    const razorpay = getRazorpayInstance();

    // Receipt max = 40 chars: "rcpt_" (5) + last6 of userId (6) + "_" (1) + base36 ts (~9) = ~21 chars
    const receipt = `rcpt_${req.user._id.toString().slice(-6)}_${Date.now().toString(36)}`;

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency,
      receipt,
      notes: { userId: req.user._id.toString(), plan: plan || 'pro' }
    });

    // Return public key_id — KEY_SECRET never leaves this file
    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    if (err.statusCode === 401) return res.status(401).json({ error: 'Razorpay authentication failed.' });
    next(err); // Pass to Sentry global handler
  }
});

// POST /api/payment/verify
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan? }
router.post('/verify', async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing required payment fields.' });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret || keySecret === 'dummy_secret') {
      return res.status(500).json({ error: 'Server payment configuration error.' });
    }

    // HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto.createHmac('sha256', keySecret).update(body).digest('hex');

    // timingSafeEqual prevents timing attacks
    const sigBuffer      = Buffer.from(razorpay_signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const isValid = sigBuffer.length === expectedBuffer.length &&
                    crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    if (!isValid) {
      return res.status(400).json({ error: 'Payment verification failed. Signature mismatch.' });
    }

    // Normalize plan name to Mongoose enum values: free | pro | premium
    const PLAN_MAP = { free: 'free', pro: 'pro', premium: 'premium', max: 'premium' };
    const selectedPlan = PLAN_MAP[plan] || 'pro';

    // Upgrade user plan with 30-day expiry
    const user = req.user;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    user.plan = selectedPlan;
    user.planExpiresAt = expiresAt;
    await user.save();

    console.log(`[Razorpay] ✅ Payment verified. User ${user._id} → "${selectedPlan}" until ${expiresAt.toISOString()}`);

    res.json({
      success: true,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
      message: `You have been upgraded to ${selectedPlan}!`
    });
  } catch (err) {
    next(err); // Pass to Sentry global handler
  }
});

module.exports = router;
