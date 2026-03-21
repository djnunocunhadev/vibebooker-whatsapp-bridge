import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import express from "express";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { usePostgresAuthState } from "./auth-state.js";

const app = express();
app.use(express.json({ strict: false }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3001;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info";

let sock = null;
let currentQR = null;
const logs = [];

const _log = console.log.bind(console);
console.log = (...args) => {
  const line = args.map(String).join(" ");
  logs.push({ t: new Date().toISOString(), msg: line });
  if (logs.length > 200) logs.shift();
  _log(...args);
};

// ─── WhatsApp connection ──────────────────────────────────────────────────────

async function connectToWhatsApp() {
  const { state, saveCreds } = await usePostgresAuthState();
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
      currentQR = qr;
      console.log("\n📱 Scan this QR code with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === "open") {
      currentQR = null;
      console.log("✅ WhatsApp connected as", sock.user?.id);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.participant || msg.key.remoteJid || "";
      const remoteJidAlt = msg.key.remoteJidAlt || "";

      let phone;
      if (remoteJid.includes("@lid")) {
        if (remoteJidAlt && !remoteJidAlt.includes("@lid")) {
          phone = remoteJidAlt.replace("@s.whatsapp.net", "").replace("@g.us", "");
          console.log(`LID resolved via remoteJidAlt: ${remoteJid} → ${phone}`);
        } else {
          phone = remoteJid.replace("@s.whatsapp.net", "").replace("@g.us", "").replace("@lid", "");
          console.log(`LID unresolved, using raw: ${phone}`);
        }
      } else {
        phone = remoteJid.replace("@s.whatsapp.net", "").replace("@g.us", "");
      }

      const content =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "[media]";

      if (msg.key.fromMe) {
        if (!/INQ-\d{4}-\d+/i.test(content)) {
          continue; // Skip own messages unless they contain an INQ code (self-testing)
        }
      }

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

function verifySecret(req, res) {
  const secret = req.headers["x-api-secret"];
  if (secret !== process.env.API_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.post("/send", async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
  if (!sock) return res.status(503).json({ error: "WhatsApp not connected" });

  try {
    const normalised = phone.replace(/^\+/, "").replace(/\s/g, "");
    const jid = normalised.includes("@") ? normalised : `${normalised}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    console.error("Send error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/send-doc", async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { phone, url, base64, fileName, caption } = req.body;
  if (!phone || (!url && !base64)) return res.status(400).json({ error: "phone and url or base64 required" });
  if (!sock) return res.status(503).json({ error: "WhatsApp not connected" });

  try {
    let buffer;
    if (base64) {
      buffer = Buffer.from(base64, "base64");
    } else {
      const response = await fetch(url);
      if (!response.ok) return res.status(502).json({ error: `Failed to fetch document: ${response.status}` });
      buffer = Buffer.from(await response.arrayBuffer());
    }
    const normalised2 = phone.replace(/^\+/, "").replace(/\s/g, "");
    const jid = normalised2.includes("@") ? normalised2 : `${normalised2}@s.whatsapp.net`;
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: "application/pdf",
      fileName: fileName || "documento.pdf",
      caption: caption || undefined,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Send-doc error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/status", (req, res) => {
  res.json({ connected: sock?.user != null, phone: sock?.user?.id || null });
});

app.get("/logs", (req, res) => {
  if (req.query.secret !== process.env.API_SECRET) return res.status(401).send("Unauthorized");
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"></head>
    <body style="background:#111;color:#0f0;font-family:monospace;padding:16px;white-space:pre-wrap;">
      ${logs.map(l => `<span style="color:#888">${l.t}</span> ${l.msg}`).join("\n")}
      <script>window.scrollTo(0,document.body.scrollHeight)</script>
    </body></html>`);
});

app.get("/qr", async (req, res) => {
  if (sock?.user) return res.send("<h2>✅ Already connected!</h2>");
  if (!currentQR) return res.send("<h2>⏳ Waiting for QR code... refresh in a few seconds.</h2>");
  const imgData = await QRCode.toDataURL(currentQR);
  res.send(`<!DOCTYPE html><html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0ece4;font-family:sans-serif;">
    <h2 style="margin-bottom:16px;">Scan with WhatsApp</h2>
    <img src="${imgData}" style="width:300px;height:300px;" />
    <p style="color:#888;margin-top:12px;">Open WhatsApp → Linked Devices → Link a Device</p>
    <script>setTimeout(()=>location.reload(),20000)</script>
  </body></html>`);
});

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp bridge listening on port ${PORT}`);
});

connectToWhatsApp();
