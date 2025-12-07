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

    // ACK Meta quickly
    res.sendStatus(200);
    if (!message) return;

    const from = message.from;
    const type = message.type;
    const text = type === "text" ? message.text.body.trim() : "";

    // Normalise spaces / case so triggers are easier to match
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    console.log("Incoming:", from, `"${text}"`, "normalized:", `"${normalized}"`);

    let replyText;

    // ---- pl ask ----
    if (normalized.startsWith("pl ask")) {
      const idx = text.toLowerCase().indexOf("pl ask");
      const question = text.slice(idx + "pl ask".length).trim();

      if (!question) {
        replyText = 'Ask something after "pl ask".';
      } else {
        try {
          const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are a concise WhatsApp assistant. Answer in 2–4 short sentences.",
              },
              { role: "user", content: question },
            ],
          });
          replyText = completion.choices[0].message.content.trim();
        } catch (err) {
          console.error("OpenAI error (pl ask):", err);
          replyText = "Unsure about answer";
        }
      }

    // ---- pl plan ----
    } else if (normalized.startsWith("pl plan")) {
      const idx = text.toLowerCase().indexOf("pl plan");
      const task = text.slice(idx + "pl plan".length).trim();

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content:
                "You plan things for busy families in Australia. Give a clear, bullet-point style plan.",
            },
            { role: "user", content: task || "Plan something simple." },
          ],
        });
        replyText = completion.choices[0].message.content.trim();
      } catch (err) {
        console.error("OpenAI error (pl plan):", err);
        replyText = "Unsure about answer";
      }

    // ---- pl help ----
    } else if (normalized === "pl help") {
      replyText =
        'Try:\n- "pl ask why is the sky blue?"\n- "pl plan Sunday family outing in Point Cook"\nAnything else I just echo back.';

    // ---- fallback echo ----
    } else {
      replyText = `You said: ${text}`;
    }

    if (replyText) {
      await sendWhatsAppText(from, replyText);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    // we already sent 200 above
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
