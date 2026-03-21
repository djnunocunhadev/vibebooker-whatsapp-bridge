import pkg from "pg";
const { Pool } = pkg;

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pool.on("error", (err) => {
      console.error("PG pool error (handled):", err.message);
    });
  }
  return pool;
}

async function ensureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function usePostgresAuthState() {
  const { initAuthCreds, BufferJSON, proto } = await import("@whiskeysockets/baileys");

  await ensureTable();

  async function readData(key) {
    const res = await getPool().query("SELECT value FROM whatsapp_auth WHERE key = $1", [key]);
    if (!res.rows[0]) return null;
    return JSON.parse(res.rows[0].value, BufferJSON.reviver);
  }

  async function writeData(key, value) {
    const serialised = JSON.stringify(value, BufferJSON.replacer);
    await getPool().query(
      `INSERT INTO whatsapp_auth (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, serialised]
    );
  }

  async function removeData(key) {
    await getPool().query("DELETE FROM whatsapp_auth WHERE key = $1", [key]);
  }

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData("creds", creds);
    },
  };
}
