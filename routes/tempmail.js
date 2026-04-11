const express = require("express");
const router = express.Router();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// ============================================
// GMAIL IMAP CLIENT CONFIGURATION
// ============================================
// ============================================
// GMAIL IMAP CLIENT CONFIGURATION
// ============================================

async function createClient() {
    return new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: {
            user: process.env.GMAIL_EMAIL || '',
            pass: process.env.GMAIL_APP_PASSWORD || ''
        },
        logger: false,
        greetingTimeout: 15000,
        connectionTimeout: 15000,
        socketTimeout: 30000,
    });
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
    let client = null;
    let lock = null;
    
    try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: "Missing email parameter" });

        if (!process.env.GMAIL_EMAIL || !process.env.GMAIL_APP_PASSWORD) {
            return res.status(500).json({ error: "Server missing Gmail credentials. Add them in Vercel Environment Variables." });
        }

        // 1. Transactional Connect (One-request-one-connection for Serverless reliability)
        client = await createClient();
        await client.connect();
        
        lock = await client.getMailboxLock('INBOX');
        const messages = [];

        // 2. ULTRA-FAST STRATEGY: Last 15 messages envelope scan
        const status = await client.status('INBOX', { messages: true });
        const totalMessages = status.messages;

        if (totalMessages > 0) {
            const startSeq = Math.max(1, totalMessages - 14);
            const seqRange = `${startSeq}:*`;
            const matchingUids = [];

            for await (let msg of client.fetch(seqRange, { envelope: true, uid: true })) {
                if (envelopeMatchesTarget(msg.envelope, email)) {
                    matchingUids.push(msg.uid);
                }
            }

            for (const uid of matchingUids) {
                try {
                    for await (let msg of client.fetch([uid], { source: true }, { uid: true })) {
                        const parsed = await simpleParser(msg.source);
                        if (fullHeaderMatch(parsed, email)) {
                            messages.push(formatMessage(uid, parsed));
                        }
                    }
                } catch (fetchErr) {
                    console.error(`[TempMail] Error fetching UID ${uid}:`, fetchErr.message);
                }
            }

            // Secondary search for older messages
            try {
                let searchUids = await client.search({ to: email }, { uid: true });
                if (Array.isArray(searchUids)) {
                    const foundUids = new Set(matchingUids);
                    const olderUids = searchUids.filter(uid => !foundUids.has(uid)).slice(-5);
                    for (const uid of olderUids) {
                        for await (let msg of client.fetch([uid], { source: true }, { uid: true })) {
                            const parsed = await simpleParser(msg.source);
                            if (fullHeaderMatch(parsed, email)) {
                                messages.push(formatMessage(uid, parsed));
                            }
                        }
                    }
                }
            } catch (searchErr) {
                console.log(`[TempMail] Index search skipped: ${searchErr.message}`);
            }
        }

        // 3. De-duplicate and sort
        const uniqueMessages = [...new Map(messages.map(m => [m.id, m])).values()];
        uniqueMessages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const result = uniqueMessages.slice(0, 10);

        res.json({ provider: "vrushabhudepurkar.tech", messages: result });

    } catch (err) {
        console.error("[TempMail] Vercel Fetch Error:", err.message);
        res.status(500).json({ error: "IMAP Error: " + err.message });
    } finally {
        // 4. Force Cleanup (CRITICAL for Serverless)
        if (lock) lock.release();
        if (client) {
            try {
                await client.logout();
                console.log("[TempMail] IMAP logged out (Transactional success).");
            } catch (logoutErr) {
                console.error("[TempMail] Logout error:", logoutErr.message);
            }
        }
    }
});


// GET single message detail (Deprecated — /messages already returns full body)
router.get("/messages/:id", (req, res) => {
    res.status(400).json({ error: "Use GET /messages?email=addr endpoint which returns full body data." });
});

module.exports = router;
