import pkg from "pg";
const { Client } = pkg;

// Baileys auth state backed by Postgres
// Stores each credential file as a row: key = filename, value = JSON

async function getClient() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function usePostgresAuthState() {
  const client = await getClient();
  await ensureTable(client);

  async function readData(key) {
    const res = await client.query("SELECT value FROM whatsapp_auth WHERE key = $1", [key]);
    return res.rows[0]?.value ?? null;
  }

  async function writeData(key, value) {
    await client.query(
      `INSERT INTO whatsapp_auth (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }

  async function removeData(key) {
    await client.query("DELETE FROM whatsapp_auth WHERE key = $1", [key]);
  }

  // Load all existing creds
  const { initAuthCreds, BufferJSON, proto } = await import("@whiskeysockets/baileys");

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
