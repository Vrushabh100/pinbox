const express = require("express");
const router = express.Router();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const dns = require('dns').promises;

const authMiddleware = require('../middleware/auth');
const TempAddress = require('../models/TempAddress');
router.use(authMiddleware);

router.use((req, res, next) => {
    if (req.user) {
        if (req.user.status === 'banned') {
            return res.status(403).json({ error: "Your account is banned" });
        }
        if (req.user.status === 'suspended') {
            let msg = "Your account is suspended.";
            if (req.user.suspendedUntil) {
                const diffMs = new Date(req.user.suspendedUntil) - new Date();
                const diffHours = Math.ceil(diffMs / (1000 * 60 * 60));
                if (diffHours > 0) {
                    msg = `YOUR ACCOUNT SUSPENDED TEMPORARILY TILL ${diffHours} HOURS.`;
                }
            }
            return res.status(403).json({ error: msg });
        }
    }
    next();
});

// ============================================
// GMAIL IMAP CLIENT CONFIGURATION
// ============================================
let imapClient = null;

// Cache: UID -> parsed message object (avoids re-downloading)
const messageCache = new Map();

async function createClient() {
    const client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: {
            user: process.env.GMAIL_EMAIL || '',
            pass: process.env.GMAIL_APP_PASSWORD || ''
        },
        logger: false,
        disableAutoIdle: false,
        greetingTimeout: 15000,
        connectionTimeout: 15000,
        socketTimeout: 60000,
    });

    client.on('close', () => {
        console.log("[TempMail] IMAP connection closed. Will reconnect on next request.");
        imapClient = null;
    });

    client.on('error', (err) => {
        console.error("[TempMail] IMAP error:", err.message);
        imapClient = null;
    });

    return client;
}

async function ensureConnected() {
    if (imapClient && !imapClient.usable) {
        console.log("[TempMail] IMAP client no longer usable, resetting.");
        imapClient = null;
    }

    if (!imapClient) {
        const client = await createClient();
        try {
            await client.connect();
            console.log("[TempMail] IMAP connected to Gmail successfully.");
            imapClient = client;
        } catch (err) {
            console.error("[TempMail] IMAP Connection Failed:", err.message);
            throw new Error("Could not connect to Gmail IMAP. Check GMAIL_EMAIL and GMAIL_APP_PASSWORD in .env");
        }
    }
    return imapClient;
}

// Check if an envelope's TO addresses match the target email
function envelopeMatchesTarget(envelope, targetEmail) {
    const targetLower = targetEmail.toLowerCase();
    const toAddresses = (envelope.to || []).map(a => (a.address || '').toLowerCase());
    const ccAddresses = (envelope.cc || []).map(a => (a.address || '').toLowerCase());
    return toAddresses.includes(targetLower) || ccAddresses.includes(targetLower);
}

// Full header check for forwarded mail (used after fetching full source)
function fullHeaderMatch(parsed, targetEmail) {
    const targetLower = targetEmail.toLowerCase();
    
    const allRecipients = [
        ...(parsed.to?.value || []),
        ...(parsed.cc?.value || []),
    ].map(r => (r.address || '').toLowerCase());

    const deliveredTo = String(parsed.headers?.get('delivered-to') || '').toLowerCase();
    const xForwardedTo = String(parsed.headers?.get('x-forwarded-to') || '').toLowerCase();
    const originalTo = String(parsed.headers?.get('x-original-to') || '').toLowerCase();

    return allRecipients.some(a => a === targetLower)
        || deliveredTo.includes(targetLower)
        || xForwardedTo.includes(targetLower)
        || originalTo.includes(targetLower);
}

// Format a parsed email into API response format
function formatMessage(uid, parsed) {
    return {
        id: uid.toString(),
        createdAt: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
        from: {
            name: parsed.from?.value?.[0]?.name || '',
            address: parsed.from?.value?.[0]?.address || ''
        },
        to: parsed.to?.value || [],
        subject: parsed.subject || '(No Subject)',
        text: parsed.text || '',
        html: parsed.html || parsed.textAsHtml || parsed.text || '',
        textBody: parsed.text || ''
    };
}

// ============================================
// MAGIC LINK EXTRACTION HELPERS
// ============================================

/**
 * Extract verification/magic link URLs from email HTML and text content.
 * These are links that services like Claude AI send instead of plain OTP codes.
 * The user must click the link, which opens a page showing the actual OTP.
 */
function extractMagicLinks(html, text) {
    const links = [];
    const seenUrls = new Set();

    // Keywords that indicate a verification/magic link
    const verifyKeywords = [
        'verify', 'confirm', 'activate', 'authenticate', 'validate',
        'magic', 'login', 'sign-in', 'signin', 'auth', 'token',
        'verification', 'confirmation', 'one-time', 'otp', 'code'
    ];

    // 1. Parse links from HTML using cheerio
    if (html) {
        try {
            const $ = cheerio.load(html);
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const linkText = $(el).text().trim().toLowerCase();
                const parentText = $(el).parent().text().trim().toLowerCase();

                if (!href.startsWith('http')) return;
                if (seenUrls.has(href)) return;

                // Check if link text or URL contains verification keywords
                const isVerifyLink = verifyKeywords.some(kw =>
                    href.toLowerCase().includes(kw) ||
                    linkText.includes(kw) ||
                    parentText.includes(kw)
                );

                // Also check common button texts
                const buttonTexts = [
                    'verify', 'confirm', 'click here', 'sign in', 'log in',
                    'complete', 'continue', 'get started', 'open', 'activate'
                ];
                const isButton = buttonTexts.some(bt => linkText.includes(bt));

                if (isVerifyLink || isButton) {
                    seenUrls.add(href);
                    links.push({
                        url: href,
                        text: $(el).text().trim() || 'Verification Link',
                        source: 'html',
                        confidence: isVerifyLink && isButton ? 'high' : 'medium'
                    });
                }
            });
        } catch (e) {
            console.error('[TempMail] Error parsing HTML for magic links:', e.message);
        }
    }

    // 2. Extract URLs from plain text using regex
    if (text) {
        const urlRegex = /https?:\/\/[^\s<>"']+/gi;
        const matches = text.match(urlRegex) || [];
        for (const url of matches) {
            if (seenUrls.has(url)) continue;
            const isVerifyUrl = verifyKeywords.some(kw => url.toLowerCase().includes(kw));
            if (isVerifyUrl) {
                seenUrls.add(url);
                links.push({
                    url: url,
                    text: 'Verification Link',
                    source: 'text',
                    confidence: 'medium'
                });
            }
        }
    }

    return links;
}

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ─── SSRF Protection ────────────────────────────────────────────────────────
// Validates a URL before allowing the server-side headless browser to navigate
// to it. Blocks private/loopback/link-local IP ranges and non-https schemes.
async function isSafeUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return false; }

    // Only allow https — no http, file, ftp, data, etc.
    if (parsed.protocol !== 'https:') return false;

    // Block common internal hostnames
    const hostname = parsed.hostname.toLowerCase();
    const blockedHostnames = ['localhost', 'metadata.google.internal'];
    if (blockedHostnames.includes(hostname)) return false;

    // If the hostname is already a raw IP, check it directly
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^\[.*\]$/;
    if (ipv4Regex.test(hostname) || ipv6Regex.test(hostname)) {
        return !isPrivateIp(hostname.replace(/[\[\]]/g, ''));
    }

    // Resolve hostname to IP(s) and check each one
    try {
        const addresses = await dns.resolve4(hostname).catch(() => []);
        const addresses6 = await dns.resolve6(hostname).catch(() => []);
        const all = [...addresses, ...addresses6];
        if (all.length === 0) return false; // unresolvable
        for (const ip of all) {
            if (isPrivateIp(ip)) return false;
        }
    } catch { return false; }

    return true;
}

function isPrivateIp(ip) {
    // IPv4 private/loopback/link-local ranges
    const privateRanges = [
        /^127\./,                        // loopback
        /^10\./,                          // RFC 1918
        /^172\.(1[6-9]|2\d|3[0-1])\./,  // RFC 1918
        /^192\.168\./,                    // RFC 1918
        /^169\.254\./,                    // link-local (AWS/GCP metadata)
        /^0\./,                           // this-network
        /^::1$/,                          // IPv6 loopback
        /^fc00:/i,                        // IPv6 unique-local
        /^fd[0-9a-f]{2}:/i,              // IPv6 unique-local
    ];
    return privateRanges.some(r => r.test(ip));
}

async function resolveOTPFromLink(url) {
    console.log(`[TempMail] Resolving magic link via Puppeteer: ${url}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));
        
        const bodyText = await page.evaluate(() => document.body.innerText);
        const pageTitle = await page.title();
        const finalUrl = page.url();
        
        const otp = extractOTPFromText(bodyText) || extractOTPFromUrl(finalUrl);
        
        return {
            success: true,
            otp: otp,
            finalUrl: finalUrl,
            status: 200,
            pageTitle: pageTitle,
            pageText: bodyText.substring(0, 500)
        };
    } catch (err) {
        console.error(`[TempMail] Magic link resolution failed: ${err.message}`);
        return {
            success: false,
            error: err.message,
            otp: null
        };
    } finally {
        if (browser) await browser.close();
    }
}

function extractOTPFromText(visibleText) {
    const patterns = [
        /(?:verification|confirm(?:ation)?|security|auth(?:entication)?|one[- ]?time|login)\s*(?:code|pin|otp|number)\s*(?:is|:)\s*(\d{4,8})/i,
        /\bOTP\s*(?:is|:|-|–)?\s*(\d{4,8})\b/i,
        /\bcode\s*(?:is|:|-|–)\s*(\d{4,8})\b/i,
        /(?:enter|use|type|input|submit)\s+(?:the\s+)?(?:code\s+)?(\d{4,8})\b/i,
        /(?:^|\n)\s*(\d{4,8})\s*(?:\n|$)/m,
    ];
    for (const pattern of patterns) {
        const match = visibleText.match(pattern);
        if (match && match[1] && !isYearNumber(match[1])) return match[1];
    }
    return null;
}

// Returns true for 4-digit numbers that look like calendar years (2020-2035).
// These commonly appear in email footers/headers and are mistaken for OTPs,
// especially when the email also contains a magic link.
function isYearNumber(candidate) {
    const n = parseInt(candidate, 10);
    return candidate.length === 4 && n >= 2020 && n <= 2035;
}

function extractOTPFromUrl(url) {
    try {
        const urlObj = new URL(url);
        for (const [key, value] of urlObj.searchParams.entries()) {
            if (/code|otp|token|pin/i.test(key) && /^\d{4,8}$/.test(value)) return value;
}
    } catch (e) {}
    return null;
}

// GET messages for a specific generated email address
router.get("/messages", async (req, res, next) => {
    try {
        const { email } = req.query;
        if (!email) {
            return res.status(400).json({ error: "Missing email parameter" });
        }

        // ── SECURITY: IDOR check ─────────────────────────────────────────────
        // Verify that the requesting user owns this address.
        // Without this, any authenticated user can read any other user's inbox.
        const ownership = await TempAddress.findOne({
            address: email.toLowerCase(),
            userId: req.user._id,
        });
        if (!ownership) {
            return res.status(403).json({ error: 'Access denied: this address does not belong to your account.' });
        }
        // ─────────────────────────────────────────────────────────

        if (!process.env.GMAIL_EMAIL || !process.env.GMAIL_APP_PASSWORD) {
            return res.status(500).json({ error: "Server missing Gmail credentials. Add GMAIL_EMAIL and GMAIL_APP_PASSWORD in .env" });
        }

        const client = await ensureConnected();

        let lock;
        try {
            lock = await client.getMailboxLock('INBOX');
        } catch (err) {
            imapClient = null;
            return res.status(500).json({ error: "Could not acquire mailbox lock: " + err.message });
        }

        const messages = [];

        try {
            // -------------------------------------------------------
            // ULTRA-FAST STRATEGY:
            //
            // 1. Fetch ONLY envelopes (To, From, Subject, Date) of the
            //    last 15 messages — this is ~100x lighter than full source.
            //    No search index needed = instant for new mail!
            //
            // 2. Check envelope TO addresses for our target email.
            //
            // 3. Only for MATCHING envelopes, download full source
            //    (or use cache if we already have it).
            //
            // This makes each poll take <200ms instead of 2-5 seconds.
            // -------------------------------------------------------

            const status = await client.status('INBOX', { messages: true });
            const totalMessages = status.messages;

            if (totalMessages > 0) {
                // Step 1: Lightweight envelope scan of last 15 messages
                const startSeq = Math.max(1, totalMessages - 14);
                const seqRange = `${startSeq}:*`;
                
                const matchingUids = [];

                // Fetch ONLY envelope + uid (very fast, no body download)
                for await (let msg of client.fetch(seqRange, { envelope: true, uid: true })) {
                    if (envelopeMatchesTarget(msg.envelope, email)) {
                        matchingUids.push(msg.uid);
                    }
                }

                // Step 2: For matches, use cache or fetch full source
                for (const uid of matchingUids) {
                    // Check cache first
                    if (messageCache.has(uid)) {
                        messages.push(messageCache.get(uid));
                        continue;
                    }

                    // Need to download this message's full source
                    try {
                        for await (let msg of client.fetch([uid], { source: true }, { uid: true })) {
                            const parsed = await simpleParser(msg.source);
                            if (fullHeaderMatch(parsed, email)) {
                                const formatted = formatMessage(uid, parsed);
                                messageCache.set(uid, formatted);
                                messages.push(formatted);
                            }
                        }
                    } catch (fetchErr) {
                        console.error(`[TempMail] Error fetching UID ${uid}:`, fetchErr.message);
                    }
                }

                // Step 3: Also check IMAP search index for older messages
                // (handles messages that scrolled past our 15-message window)
                try {
                    let searchUids = await client.search({ to: email }, { uid: true });
                    if (!Array.isArray(searchUids)) searchUids = [];
                    
                    const foundUids = new Set(matchingUids);
                    const olderUids = searchUids.filter(uid => !foundUids.has(uid));

                    if (olderUids.length > 0) {
                        const toFetch = olderUids.slice(-5); // max 5 older ones
                        for (const uid of toFetch) {
                            if (messageCache.has(uid)) {
                                messages.push(messageCache.get(uid));
                                continue;
                            }
                            try {
                                for await (let msg of client.fetch([uid], { source: true }, { uid: true })) {
                                    const parsed = await simpleParser(msg.source);
                                    if (fullHeaderMatch(parsed, email)) {
                                        const formatted = formatMessage(uid, parsed);
                                        messageCache.set(uid, formatted);
                                        messages.push(formatted);
                                    }
                                }
                            } catch (fetchErr) {
                                console.error(`[TempMail] Error fetching older UID ${uid}:`, fetchErr.message);
                            }
                        }
                    }
                } catch (searchErr) {
                    // Search index might not be ready yet — that's fine, fast path handles it
                    console.log(`[TempMail] Index search skipped: ${searchErr.message}`);
                }
            }

        } finally {
            lock.release();
        }

        // De-duplicate, sort latest first, limit to 10
        const uniqueMessages = [...new Map(messages.map(m => [m.id, m])).values()];
        uniqueMessages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const result = uniqueMessages.slice(0, 10);

        res.json({ provider: "aiplex.app", messages: result });

    } catch (err) {
        if (err.message.includes('IMAP') || err.message.includes('connect') || err.message.includes('socket')) {
            imapClient = null;
        }
        next(err);
    }
});

// ============================================
// MAGIC LINK RESOLVER ENDPOINT
// ============================================

/**
 * POST /api/tempmail/resolve-link
 * 
 * Accepts a magic link URL, follows it server-side, and extracts any
 * OTP/verification code displayed on the resulting page.
 * 
 * Body: { url: "https://..." }
 * Response: { success, otp, finalUrl, pageTitle, pageText }
 */
router.post("/resolve-link", async (req, res, next) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: "Missing 'url' in request body" });
        }

        // ── SECURITY: SSRF protection ───────────────────────────────────────
        // Validate scheme and resolve hostname to block private/internal IPs.
        // Prevents the server-side browser from hitting metadata endpoints,
        // internal admin panels, or cloud instance identity services.
        const safe = await isSafeUrl(url);
        if (!safe) {
            return res.status(400).json({ error: 'URL is not allowed. Only public HTTPS URLs are permitted.' });
        }
        // ─────────────────────────────────────────────────────────

        const result = await resolveOTPFromLink(url);
        res.json(result);

    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/tempmail/extract-links
 * 
 * Extracts magic/verification links from email HTML and text content.
 * 
 * Body: { html: "...", text: "..." }
 * Response: { links: [...] }
 */
router.post("/extract-links", async (req, res, next) => {
    try {
        const { html, text } = req.body;

        if (!html && !text) {
            return res.status(400).json({ error: "Missing 'html' or 'text' in request body" });
        }

        const links = extractMagicLinks(html || '', text || '');
        res.json({ links });

    } catch (err) {
        next(err);
    }
});

// GET single message detail (Deprecated — /messages already returns full body)
router.get("/messages/:id", (req, res) => {
    res.status(400).json({ error: "Use GET /messages?email=addr endpoint which returns full body data." });
});

/**
 * GET /api/tempmail/limits
 * Returns the user's current limits and plan.
 */
router.get("/limits", async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) return res.status(401).json({ error: "Unauthorized" });
        const User = require('../models/User');
        const userDoc = await User.findById(req.user._id);
        if (!userDoc) return res.status(404).json({ error: "User not found" });
        
        res.json({
            plan: userDoc.plan || 'free',
            emailsGenerated: userDoc.usage?.emailsGenerated || 0,
            otpRetrieved: userDoc.usage?.otpRetrieved || 0
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/tempmail/track
 * Tracks user actions for analytics (e.g. emailsGenerated, otpRetrieved)
 * Now also enforces usage limits.
 */
router.post("/track", async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) return res.status(401).json({ error: "Unauthorized" });
        const { action, email } = req.body;
        
        const User = require('../models/User'); 
        const userDoc = await User.findById(req.user._id);
        
        if (!userDoc) return res.status(404).json({ error: "User not found" });

        // Enforce Limits
        if (userDoc.plan === 'free') {
            if (action === 'emailsGenerated' && (userDoc.usage?.emailsGenerated || 0) >= 20) {
                return res.status(403).json({ error: "LimitReached", type: "email" });
            }
            if (action === 'otpRetrieved' && (userDoc.usage?.otpRetrieved || 0) >= 6) {
                return res.status(403).json({ error: "LimitReached", type: "otp" });
            }
        }
        
        const updateField = {};
        if (action === 'emailsGenerated') updateField['usage.emailsGenerated'] = 1;
        else if (action === 'otpRetrieved') updateField['usage.otpRetrieved'] = 1;
        else return res.status(400).json({ error: "Invalid action" });

        await User.findByIdAndUpdate(req.user._id, { $inc: updateField });

        // ── SECURITY: save address ownership record ───────────────────────────
        // When a new temp-mail address is generated, bind it to this user so
        // GET /messages can verify ownership and prevent IDOR attacks.
        if (action === 'emailsGenerated' && email) {
            await TempAddress.findOneAndUpdate(
                { address: email.toLowerCase(), userId: req.user._id },
                { address: email.toLowerCase(), userId: req.user._id, createdAt: new Date() },
                { upsert: true, setDefaultsOnInsert: true }
            );
        }

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
