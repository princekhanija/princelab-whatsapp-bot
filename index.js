import express from "express";
import axios from "axios";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

const app = express();
app.use(express.json());

// ================== ENV ==================
const VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN || "princelab-verify";

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Main chat model (override in Render if you want)
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Cheaper model for summaries
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "gpt-4.1-nano";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================== RATE LIMITS ==================

// 1) Endpoint-level limiter (generous for Meta retries)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/webhook", webhookLimiter);

// 2) Per-user AI limiter
const userRate = new Map();
const PER_MIN = Number(process.env.PER_USER_PER_MIN || 6);
const PER_HOUR = Number(process.env.PER_USER_PER_HOUR || 60);

function checkUserLimit(userId) {
  const now = Date.now();
  const rec = userRate.get(userId) || { min: [], hour: [] };

  rec.min = rec.min.filter((t) => now - t < 60 * 1000);
  rec.hour = rec.hour.filter((t) => now - t < 60 * 60 * 1000);

  if (rec.min.length >= PER_MIN) return { ok: false, scope: "minute" };
  if (rec.hour.length >= PER_HOUR) return { ok: false, scope: "hour" };

  rec.min.push(now);
  rec.hour.push(now);
  userRate.set(userId, rec);

  return { ok: true };
}

// ================== CONTEXT STORE (IN-MEMORY) ==================
// Rules you asked for:
// - Keep max 100 messages per user (user+assistant combined).
// - Use last 50 messages as raw context.
// - Messages older than that (up to 100 total) are summarized.
// - Hard stop at 100 stored messages.

const historyByUser = new Map();
const MAX_USERS_IN_MEMORY = 500;
const HISTORY_LIMIT = 100;
const RECENT_RAW_LIMIT = 50;

function getRecord(userId) {
  if (!historyByUser.has(userId)) {
    historyByUser.set(userId, {
      messages: [],
      summary: "",
      summarizedCount: 0, // how many messages from the start are included in summary
      lastSeen: Date.now(),
    });
  }
  const record = historyByUser.get(userId);
  record.lastSeen = Date.now();
  return record;
}

function trimToLimit(record) {
  const msgs = record.messages;
  if (msgs.length <= HISTORY_LIMIT) return;

  const overflow = msgs.length - HISTORY_LIMIT;

  // If we're dropping messages that were not yet summarized,
  // advance summarizedCount so indices remain consistent.
  record.summarizedCount = Math.max(0, record.summarizedCount - overflow);

  msgs.splice(0, overflow);
}

function pushToHistory(userId, role, content) {
  const record = getRecord(userId);
  record.messages.push({ role, content });

  trimToLimit(record);

  // Cap number of users in memory
  if (historyByUser.size > MAX_USERS_IN_MEMORY) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of historyByUser.entries()) {
      if (v.lastSeen < oldestTime) {
        oldestTime = v.lastSeen;
        oldestKey = k;
      }
    }
    if (oldestKey) historyByUser.delete(oldestKey);
  }
}

// Cleanup stale users (older than 24h)
const STALE_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of historyByUser.entries()) {
    if (now - v.lastSeen > STALE_MS) {
      historyByUser.delete(k);
      userRate.delete(k);
    }
  }
}, 30 * 60 * 1000).unref();

// ================== 1) Webhook verification ==================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ================== 2) Webhook receiver ==================
app.post("/webhook", (req, res) => {
  // ACK Meta immediately
  res.sendStatus(200);

  (async () => {
    try {
      console.log("WEBHOOK HIT:", JSON.stringify(req.body, null, 2));

      const entry = req.body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const message = value?.messages?.[0];
      if (!message) return;

      const from = message.from;
      const type = message.type;

      // Only handle text
      const rawText =
        type === "text" ? (message.text?.body || "").trim() : "";
      if (!rawText) return;

      // Strip @PrinceLab mention if used
      const cleanedText = rawText.replace(/@princelab(\.au)?/gi, "").trim();
      const userText = cleanedText.length > 0 ? cleanedText : rawText;

      console.log("Incoming:", from, `"${rawText}"`, "cleaned:", `"${userText}"`);

      // Per-user AI rate limit
      const limit = checkUserLimit(from);
      if (!limit.ok) {
        await sendWhatsAppText(
          from,
          limit.scope === "minute"
            ? "Too many messages too quickly. Try again in a minute."
            : "You’ve hit the hourly limit. Try again later."
        );
        return;
      }

      // 1) Store user message
      pushToHistory(from, "user", userText);

      // 2) Build reply with context rules
      const replyText = await askAIWithSmartContext(from);

      // 3) Send reply
      if (replyText) {
        await sendWhatsAppText(from, replyText);

        // 4) Store assistant reply
        pushToHistory(from, "assistant", replyText);
      }
    } catch (err) {
      console.error("Webhook processing error:", err);
    }
  })();
});

// ================== SMART CONTEXT + SUMMARIES ==================
async function askAIWithSmartContext(userId) {
  const record = getRecord(userId);
  const msgs = record.messages;

  try {
    // If more than last 50 exist, summarize older chunk incrementally
    const olderCount = Math.max(0, msgs.length - RECENT_RAW_LIMIT);

    if (olderCount > 0) {
      // We only need to summarize messages from the start up to olderCount
      // Ensure our summary covers that range
      if (record.summarizedCount < olderCount) {
        const newChunk = msgs.slice(record.summarizedCount, olderCount);
        record.summary = await updateSummary(record.summary, newChunk);
        record.summarizedCount = olderCount;
      }
    } else {
      // If conversation is short again, reset summary state
      record.summary = "";
      record.summarizedCount = 0;
    }

    const recent = msgs.slice(-RECENT_RAW_LIMIT);

    const messagesForModel = [
      {
        role: "system",
        content:
          "You are a concise WhatsApp assistant. Answer in 2–4 short sentences. Plain text only."
      }
    ];

    if (record.summary) {
      messagesForModel.push({
        role: "system",
        content: `Conversation summary (older context): ${record.summary}`
      });
    }

    messagesForModel.push(...recent);

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: messagesForModel
    });

    return completion.choices?.[0]?.message?.content?.trim() || "Unsure about answer";
  } catch (e) {
    console.error("OpenAI error:", e.response?.data || e.message);
    return "Unsure about answer";
  }
}

async function updateSummary(existingSummary, newMessages) {
  if (!newMessages || newMessages.length === 0) return existingSummary || "";

  // Convert new messages into a compact text block for summarization
  const chunkText = newMessages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  try {
    const completion = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You update a running conversation summary. Keep it short, factual, and plain text. " +
            "Preserve important names, decisions, preferences, and unresolved questions. " +
            "No markdown."
        },
        {
          role: "user",
          content:
            `Existing summary:\n${existingSummary || "(none)"}\n\n` +
            `New messages to incorporate:\n${chunkText}\n\n` +
            "Return the updated summary only."
        }
      ]
    });

    return completion.choices?.[0]?.message?.content?.trim() || existingSummary || "";
  } catch (e) {
    console.error("Summary error:", e.response?.data || e.message);
    // If summary fails, fall back to existing summary
    return existingSummary || "";
  }
}

// ================== WhatsApp send helper ==================
async function sendWhatsAppText(to, body) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
    return;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (e) {
    console.error("WhatsApp send error:", e.response?.data || e.message);
  }
}

// ================== Server ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PrinceLab bot listening on port ${PORT}`);
});
