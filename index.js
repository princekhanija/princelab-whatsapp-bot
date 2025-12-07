import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// ================== ENV ==================
const VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN || "princelab-verify";

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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
  // Always ACK Meta immediately
  res.sendStatus(200);

  // Process async after ACK
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

      // Only handle text for now
      const rawText =
        type === "text" ? (message.text?.body || "").trim() : "";
      if (!rawText) return;

      // Detect @PrinceLab mention (case-insensitive, with or without .au)
      const lowerRaw = rawText.toLowerCase();
      const mentionedBot = lowerRaw.includes("@princelab");

      // Strip the mention out for command parsing
      const text = rawText.replace(/@princelab(\.au)?/gi, "").trim();
      const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

      console.log(
        "Incoming:",
        from,
        `"${rawText}"`,
        "mentionedBot:",
        mentionedBot,
        "normalized:",
        `"${normalized}"`
      );

      let replyText = "";

      // ---------- pl help ----------
      if (normalized === "pl help") {
        replyText =
          'Try:\n' +
          '- "pl ask why is the sky blue?"\n' +
          '- "pl plan Sunday family outing in Point Cook"\n' +
          '- In a group: "@PrinceLab.au what should we do this Sunday?"';

      // ---------- pl ask ----------
      } else if (normalized.startsWith("pl ask")) {
        const question = text.slice(6).trim(); // remove "pl ask"
        if (!question) {
          replyText = 'Ask something after "pl ask".';
        } else {
          replyText = await askAI(question);
        }

      // ---------- pl plan ----------
      } else if (normalized.startsWith("pl plan")) {
        const task = text.slice(7).trim(); // remove "pl plan"
        replyText = await planWithAI(task || "Plan something simple.");

      // ---------- Mention without explicit command ----------
      } else if (mentionedBot && normalized.length > 0) {
        replyText = await askAI(text);

      // ---------- Fallback ----------
      } else {
        replyText = `You said: ${rawText}`;
      }

      if (replyText) {
        await sendWhatsAppText(from, replyText);
      }
    } catch (err) {
      console.error("Webhook processing error:", err);
    }
  })();
});

// ================== OpenAI helpers ==================
async function askAI(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a concise WhatsApp assistant. Answer in 2–4 short sentences. No markdown."
        },
        { role: "user", content: question }
      ]
    });

    return completion.choices?.[0]?.message?.content?.trim() || "Unsure about answer";
  } catch (e) {
    console.error("askAI error:", e.response?.data || e.message);
    return "Unsure about answer";
  }
}

async function planWithAI(details) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You plan things for busy families in Australia. Reply with 3–5 short bullet points. Plain text."
        },
        { role: "user", content: details }
      ]
    });

    return completion.choices?.[0]?.message?.content?.trim() || "Unsure about answer";
  } catch (e) {
    console.error("planWithAI error:", e.response?.data || e.message);
    return "Unsure about answer";
  }
}

// ================== WhatsApp send helper ==================
async function sendWhatsAppText(to, body) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.error("Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_ID");
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
