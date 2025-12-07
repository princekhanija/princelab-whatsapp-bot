import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// ENV VARS
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "princelab-verify";
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1) Webhook verification (Meta calls GET here once)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Webhook receiver (incoming messages)
app.post("/webhook", async (req, res) => {
  try {
    console.log("WEBHOOK HIT:", JSON.stringify(req.body, null, 2));
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    // Always ACK quickly
    res.sendStatus(200);

    if (!message) return;

    const from = message.from;
    const type = message.type;
    const text = type === "text" ? message.text.body.trim() : "";

    const lower = text.toLowerCase();
    const isTrigger = lower.startsWith("pl ") || lower.startsWith("@princelab");

    if (!isTrigger) return;

    let reply = "Try:\n• pl ask <question>\n• pl plan <what/when/where>";

    if (lower.startsWith("pl ask")) {
      const question = text.slice(6).trim();
      reply = await askAI(question || "Explain what you can do.");
    } else if (lower.startsWith("pl plan")) {
      const details = text.slice(7).trim() || "a simple catch-up";
      reply = await planWithAI(details);
    }

    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error("Webhook error:", err.message);
    // We already sent 200 above, nothing else to do
  }
});

// --- OpenAI helpers ---

async function askAI(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You reply for a WhatsApp bot. Short, clear answers. No markdown."
        },
        { role: "user", content: question }
      ]
    });
    return completion.choices[0].message.content.trim();
  } catch (e) {
    console.error("askAI error:", e.message);
    return "I couldn't get an answer just now. Try again in a minute.";
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
            "You help small WhatsApp groups plan simple things (dinners, meetups, movies). " +
            "Reply with 3–5 short bullet points. Plain text, no emojis."
        },
        { role: "user", content: `Plan this for the group: ${details}` }
      ]
    });
    return completion.choices[0].message.content.trim();
  } catch (e) {
    console.error("planWithAI error:", e.message);
    return "I had trouble planning that. Try again shortly.";
  }
}

// --- WhatsApp send helper ---

async function sendWhatsAppText(to, body) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PrinceLab bot listening on port ${PORT}`);
});
