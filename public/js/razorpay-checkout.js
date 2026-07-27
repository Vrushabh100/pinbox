// ============================================
// Pinboxx - Razorpay Frontend Checkout Module
// razorpay-checkout.js
//
// ⚠️  SECURITY:
//   • KEY_ID arrives from the server's create-order response — never hardcoded here.
//   • KEY_SECRET NEVER reaches the browser — all signature work is server-side only.
//   • checkout.js is loaded lazily so it doesn't slow down page load.
// ============================================

/**
 * Lazily inject the Razorpay checkout.js script (only once).
 */
function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    if (document.getElementById('rzp-checkout-script')) {
      document.getElementById('rzp-checkout-script').addEventListener('load', resolve);
      document.getElementById('rzp-checkout-script').addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.id = 'rzp-checkout-script';
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load Razorpay checkout script.'));
    document.head.appendChild(script);
  });
}

/**
 * Get the JWT token using storage.js's getToken() which handles expiry checks.
 * Falls back to reading localStorage directly with the same key.
 */
function _getAuthToken() {
  if (typeof getToken === 'function') return getToken();
  return localStorage.getItem('cobox_jwt_v2') || null;
}

/**
 * Initiates the full Razorpay payment flow.
 *
 * @param {object} options
 * @param {number}   options.amountINR     Amount in whole Indian Rupees (e.g. 299)
 * @param {string}   options.plan          'pro' | 'premium'
 * @param {string}   [options.description] Modal description text
 * @param {Function} [options.onSuccess]   Called with { plan, planExpiresAt } on verified success
 * @param {Function} [options.onFailure]   Called with an error message string on any failure
 */
async function initiateRazorpayCheckout({ amountINR, plan, description, onSuccess, onFailure } = {}) {
  // Default to Pro plan if called from old onclick="initiateRazorpayCheckout()"
  amountINR = amountINR || 299;
  plan      = plan      || 'pro';

  const token = _getAuthToken();
  if (!token) {
    if (onFailure) onFailure('You must be logged in to make a payment.');
    else if (typeof showToast === 'function') showToast('Please log in first to upgrade.', 'warning');
    return;
  }

  try {
    // ── STEP 1: Load Razorpay checkout.js ──────────────────────────────────────
    await loadRazorpayScript();

    // ── STEP 2: Create order server-side (KEY_SECRET never used here) ──────────
    const orderRes = await fetch('/api/payment/create-order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ amount: amountINR, currency: 'INR', plan })
    });

    if (!orderRes.ok) {
      const err = await orderRes.json().catch(() => ({}));
      throw new Error(err.error || 'Could not create payment order. Please try again.');
    }

    const { order_id, amount, currency, key_id } = await orderRes.json();

    // ── STEP 3: Open Razorpay modal ────────────────────────────────────────────
    await new Promise((resolve, reject) => {
      const rzpOptions = {
        key: key_id,       // Public KEY_ID from server — safe in browser
        amount,            // Paise — provided by server
        currency,
        name: 'Pinboxx',
        description: description || `Pinboxx ${plan === 'pro' ? 'Pro' : 'Max'} Plan`,
        order_id,
        modal: {
          ondismiss() { reject(new Error('CANCELLED')); }
        },
        handler(response) { resolve(response); },
        prefill: {},
        theme: { color: '#10b981' }  // Pinboxx emerald accent
      };

      const rzp = new window.Razorpay(rzpOptions);
      rzp.on('payment.failed', (response) => {
        reject(new Error(response.error?.description || 'Payment failed.'));
      });
      rzp.open();
    })
    .then(async (paymentResponse) => {
      // ── STEP 4: Verify signature server-side ───────────────────────────────
      const verifyRes = await fetch('/api/payment/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          razorpay_order_id:   paymentResponse.razorpay_order_id,
          razorpay_payment_id: paymentResponse.razorpay_payment_id,
          razorpay_signature:  paymentResponse.razorpay_signature,
          plan
        })
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || 'Payment verification failed. Please contact support.');
      }

      const result = await verifyRes.json();
      if (onSuccess) {
        onSuccess(result);
      } else {
        // Default success behaviour
        if (typeof showToast === 'function') {
          showToast(`🎉 Payment successful! You are now on the ${result.plan} plan.`, 'success');
        }
        // Update button state immediately
        if (typeof updateProButtonState === 'function') updateProButtonState();
        setTimeout(() => window.location.reload(), 1500);
      }
    })
    .catch((err) => {
      if (err.message === 'CANCELLED') {
        if (onFailure) onFailure('Payment was cancelled.');
        else if (typeof showToast === 'function') showToast('Payment cancelled.', 'info');
      } else {
        if (onFailure) onFailure(err.message);
        else if (typeof showToast === 'function') showToast('Payment failed: ' + err.message, 'error');
        else alert('Payment failed: ' + err.message);
      }
    });

  } catch (err) {
    console.error('[Pinboxx Payment] Error:', err);
    if (onFailure) onFailure(err.message || 'An unexpected error occurred during payment.');
    else if (typeof showToast === 'function') showToast(err.message || 'Payment error occurred.', 'error');
  }
}

// Expose globally so inline onclick="initiateRazorpayCheckout()" works too
window.initiateRazorpayCheckout = initiateRazorpayCheckout;
