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
// ALL incoming text messages are treated as questions.
app.post("/webhook", (req, res) => {
  // ACK Meta immediately
  res.sendStatus(200);

  // Process asynchronously after ACK
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

      // Optional: strip @PrinceLab mention if someone uses it in a group
      // (harmless for 1:1 too)
      const cleanedText = rawText.replace(/@princelab(\.au)?/gi, "").trim();

      console.log("Incoming:", from, `"${rawText}"`, "cleaned:", `"${cleanedText}"`);

      const questionToAsk = cleanedText.length > 0 ? cleanedText : rawText;

      const replyText = await askAI(questionToAsk);

      if (replyText) {
        await sendWhatsAppText(from, replyText);
      }
    } catch (err) {
      console.error("Webhook processing error:", err);
    }
  })();
});

// ================== OpenAI helper ==================
async function askAI(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a concise WhatsApp assistant. Answer in 2–4 short sentences. Plain text only."
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
