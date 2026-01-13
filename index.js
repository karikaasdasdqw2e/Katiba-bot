const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const { DateTime } = require("luxon");

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const TZ = "Africa/Cairo";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Public DB غالبًا يحتاج SSL
  ssl: { rejectUnauthorized: false },
});

const sessions = new Map();

// ====== Menu (Reply Keyboard) ======
const MENU = Markup.keyboard([
  ["➕ إضافة أوردر جديد", "📌 الأوردرات المحجوزة"],
  ["🕘 آخر 5 أوردرات", "ℹ️ مساعدة"],
]).resize();

function helpText() {
  return (
    "أهلاً 👋 أنا بوت Katiba Events\n\n" +
    "اختار من القايمة تحت 👇\n" +
    "➕ إضافة أوردر جديد\n" +
    "📌 الأوردرات المحجوزة (القادمة)\n" +
    "🕘 آخر 5 أوردرات\n\n" +
    "لو محتاج Telegram ID بتاعك اكتب: id"
  );
}

async function upsertUser(ctx) {
  const id = ctx.from.id;
  const name =
    (ctx.from.first_name || "") +
    (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");
  await pool.query(
    `INSERT INTO users (telegram_id, name) VALUES ($1,$2)
     ON CONFLICT (telegram_id) DO UPDATE SET name=EXCLUDED.name`,
    [id, (name || "مستخدم").trim()]
  );
}

// ====== DB init + safe migration ======
async function initDb() {
  // users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // orders table (new schema)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      created_by BIGINT,
      client_name TEXT NOT NULL,
      event_date TEXT NOT NULL,   -- YYYY-MM-DD
      location TEXT NOT NULL,
      details TEXT NOT NULL,
      deposit INTEGER NOT NULL,   -- EGP
      status TEXT DEFAULT 'قيد المراجعة',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // If you had old schema before, this keeps it from breaking.
  // Add missing columns if table existed with older structure.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_date TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS location TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS details TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

  // Backfill: if you had old datetime_iso column, try to fill event_date from it (optional)
  // (Will only run if datetime_iso exists)
  try {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='orders' AND column_name='datetime_iso'
    `);
    if (cols.rows.length) {
      await pool.query(`
        UPDATE orders
        SET event_date = COALESCE(event_date, (datetime_iso::timestamptz AT TIME ZONE '${TZ}')::date::text)
        WHERE event_date IS NULL
      `);
    }
  } catch (_) {}

  // Ensure defaults if nulls exist (for older rows)
  await pool.query(`UPDATE orders SET status = COALESCE(status, 'قيد المراجعة') WHERE status IS NULL;`);

  console.log("DB ready");
}

// ====== Order flow (NO TIME) ======
function startNewOrder(ctx) {
  sessions.set(ctx.from.id, { step: "client" });
  return ctx.reply("🧑‍💼 اكتب اسم صاحب الفرح (الزبون):", MENU);
}

bot.start(async (ctx) => {
  await upsertUser(ctx);
  return ctx.reply(helpText(), MENU);
});

bot.hears(/^id$/i, (ctx) => ctx.reply(`Telegram ID بتاعك هو:\n${ctx.from.id}`, MENU));

bot.hears("ℹ️ مساعدة", (ctx) => ctx.reply(helpText(), MENU));
bot.hears("➕ إضافة أوردر جديد", (ctx) => startNewOrder(ctx));
bot.command("new", (ctx) => startNewOrder(ctx));
