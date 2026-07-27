const express = require("express");
const router = express.Router();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');

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
        if (match && match[1]) return match[1];
    }
    return null;
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

        // Basic URL validation
        try {
            new URL(url);
        } catch (e) {
            return res.status(400).json({ error: "Invalid URL provided" });
        }

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


module.exports = router;
