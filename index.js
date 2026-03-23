import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import express from "express";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createHash, timingSafeEqual } from "crypto";
import { usePostgresAuthState, getPool } from "./auth-state.js";

const app = express();

// Security headers
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled — QR page uses inline styles

// Body parsing with size limits
app.use(express.json({ strict: false, limit: "10mb" })); // 10mb for base64 PDF in /send-doc
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Rate limiting — global: 120 req / 1 min per IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, slow down." },
}));

// Stricter limiter for message-sending endpoints: 20 req / 1 min per IP
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Message rate limit exceeded." },
});

const PORT = process.env.PORT || 3001;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

let sock = null;
let currentQR = null;
let isConnecting = false;
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
  if (isConnecting) { console.log("⏳ Already connecting, skipping duplicate call."); return; }
  isConnecting = true;
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
      isConnecting = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === "open") {
      isConnecting = false;
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
        console.log(`📤 Forwarding to webhook: ${WEBHOOK_URL}`);
        try {
          const whRes = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-webhook-secret": WEBHOOK_SECRET || "",
            },
            body: JSON.stringify({ phone, content, messageId, pushName }),
          });
          const whBody = await whRes.text();
          console.log(`📥 Webhook response: ${whRes.status} ${whBody.slice(0, 200)}`);
        } catch (e) {
          console.error("Webhook error:", e.message);
        }
      } else {
        console.warn("⚠️ WEBHOOK_URL not set, skipping forward");
      }
    }
  });
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────

// Timing-safe secret verification — prevents timing side-channel attacks
function verifySecret(req, res) {
  const incoming = req.headers["x-api-secret"];
  const expected = process.env.API_SECRET;
  if (!incoming || !expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  // Hash both to equal length before comparing
  const hi = createHash("sha256").update(incoming).digest();
  const he = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(hi, he)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

const MAX_MSG_LEN = 4096;
const PHONE_RE = /^\+?[\d\s\-(). ]{7,20}$/;

app.post("/send", sendLimiter, async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: "Invalid phone number format" });
  if (message.length > MAX_MSG_LEN) return res.status(400).json({ error: "Message too long" });
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

app.post("/send-doc", sendLimiter, async (req, res) => {
  if (!verifySecret(req, res)) return;
  const { phone, url, base64, fileName, caption } = req.body;
  if (!phone || (!url && !base64)) return res.status(400).json({ error: "phone and url or base64 required" });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: "Invalid phone number format" });
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

app.get("/status", (req, res) => {
  if (req.query.secret !== process.env.API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  res.json({ connected: sock?.user != null, phone: sock?.user?.id || null });
});

app.get("/logs", (req, res) => {
  if (req.query.secret !== process.env.API_SECRET) return res.status(401).send("Unauthorized");
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"></head>
    <body style="background:#111;color:#0f0;font-family:monospace;padding:16px;white-space:pre-wrap;">
      ${logs.map(l => `<span style="color:#888">${escapeHtml(l.t)}</span> ${escapeHtml(l.msg)}`).join("\n")}
      <script>window.scrollTo(0,document.body.scrollHeight)</script>
    </body></html>`);
});

app.get("/qr", async (req, res) => {
  if (req.query.secret !== process.env.API_SECRET) return res.status(401).send("Unauthorized");
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

app.post("/logout", async (req, res) => {
  if (!verifySecret(req, res)) return;
  if (!sock) return res.json({ ok: true, message: "Already disconnected." });
  try {
    await sock.logout().catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true, message: "Disconnected (was already closed)." });
  }
});

app.post("/clear", async (req, res) => {
  if (!verifySecret(req, res)) return;
  try {
    if (sock) await sock.logout().catch(() => {});
    await getPool().query("TRUNCATE TABLE whatsapp_auth");
    res.json({ ok: true, message: "Session cleared. Bridge will now require a new QR scan." });
    setTimeout(() => {
      console.log("♻️ Restarting connection after clear...");
      isConnecting = false;
      connectToWhatsApp();
    }, 2000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 WhatsApp bridge listening on port ${PORT}`);
});

connectToWhatsApp();
