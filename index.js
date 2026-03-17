const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const express = require("express");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://thisisusevents.pt/api/whatsapp/incoming
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";

let sock = null;

// ─── WhatsApp connection ──────────────────────────────────────────────────────

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ["This Is Us Events", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n📱 Scan this QR code with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === "open") {
      console.log("✅ WhatsApp connected");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue; // skip messages we sent
      if (!msg.message) continue;

      const from = msg.key.remoteJid; // e.g. 351912345678@s.whatsapp.net
      const phone = from.replace("@s.whatsapp.net", "").replace("@g.us", "");
      const content =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        "[media]";
      const messageId = msg.key.id;
      const pushName = msg.pushName || null;

      console.log(`📨 Message from ${phone}: ${content}`);

      if (WEBHOOK_URL) {
        try {
          await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-webhook-secret": WEBHOOK_SECRET || "",
            },
            body: JSON.stringify({ phone, content, messageId, pushName }),
          });
        } catch (e) {
          console.error("Webhook error:", e.message);
        }
      }
    }
  });
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────

// Verify requests from Vercel
function verifySecret(req, res) {
  const secret = req.headers["x-api-secret"];
  if (secret !== process.env.API_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// POST /send — send a WhatsApp message
app.post("/send", async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
  if (!sock) return res.status(503).json({ error: "WhatsApp not connected" });

  try {
    const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    console.error("Send error:", e);
    res.status(500).json({ error: e.message });
  }
});

// GET /status — health check
app.get("/status", (req, res) => {
  res.json({ connected: sock?.user != null, phone: sock?.user?.id || null });
});

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp bridge listening on port ${PORT}`);
});

connectToWhatsApp();
