const express = require("express");
const router = express.Router();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

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

// GET messages for a specific generated email address
router.get("/messages", async (req, res) => {
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

        res.json({ provider: "vrushabhudepurkar.tech", messages: result });

    } catch (err) {
        console.error("[TempMail] Fetch messages error:", err.message);
        if (err.message.includes('IMAP') || err.message.includes('connect') || err.message.includes('socket')) {
            imapClient = null;
        }
        res.status(500).json({ error: err.message });
    }
});

// GET single message detail (Deprecated — /messages already returns full body)
router.get("/messages/:id", (req, res) => {
    res.status(400).json({ error: "Use GET /messages?email=addr endpoint which returns full body data." });
});

module.exports = router;
