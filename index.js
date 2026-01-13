const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const { DateTime } = require("luxon");

// ====== ENV CHECK ======
if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

// ====== INIT ======
const bot = new Telegraf(process.env.BOT_TOKEN);
const TZ = "Africa/Cairo";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const sessions = new Map();

// ====== MENU ======
const MENU = Markup.keyboard([
  ["➕ إضافة أوردر جديد", "📌 الأوردرات المحجوزة"],
  ["🕘 آخر 5 أوردرات", "ℹ️ مساعدة"],
]).resize();

const helpText =
  "أهلاً 👋 أنا بوت Katiba Events\n\n" +
  "اختار من القايمة تحت 👇\n" +
  "➕ إضافة أوردر جديد\n" +
  "📌 الأوردرات المحجوزة\n" +
  "🕘 آخر 5 أوردرات\n\n" +
  "لمعرفة Telegram ID اكتب: id";

// ====== DB ======
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      name TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      created_by BIGINT,
      client_name TEXT,
      event_date TEXT,
      location TEXT,
      details TEXT,
      deposit INTEGER,
      status TEXT DEFAULT 'قيد المراجعة',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("DB ready");
}

// ====== HELPERS ======
async function upsertUser(ctx) {
  const name =
    (ctx.from.first_name || "") +
    (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");

  await pool.query(
    `INSERT INTO users (telegram_id, name)
     VALUES ($1,$2)
     ON CONFLICT (telegram_id) DO UPDATE SET name=$2`,
    [ctx.from.id, name || "مستخدم"]
  );
}

function startNewOrder(ctx) {
  sessions.set(ctx.from.id, { step: "client" });
  ctx.reply("🧑‍💼 اكتب اسم صاحب الفرح:", MENU);
}

// ====== COMMANDS ======
bot.start(async (ctx) => {
  await upsertUser(ctx);
  ctx.reply(helpText, MENU);
});

bot.hears(/^id$/i, (ctx) =>
  ctx.reply(`Telegram ID بتاعك:\n${ctx.from.id}`, MENU)
);

bot.hears("ℹ️ مساعدة", (ctx) => ctx.reply(helpText, MENU));

bot.hears("➕ إضافة أوردر جديد", (ctx) => startNewOrder(ctx));

bot.hears("🕘 آخر 5 أوردرات", async (ctx) => {
  const res = await pool.query(
    `SELECT id, client_name, event_date, location, deposit
     FROM orders
     ORDER BY id DESC
     LIMIT 5`
  );

  if (res.rows.length === 0) {
    return ctx.reply("مفيش أوردرات لسه.", MENU);
  }

  const msg = res.rows
    .map(
      (r) =>
        `#${r.id} | ${r.client_name} | ${r.event_date} | ${r.location} | عربون: ${r.deposit}ج`
    )
    .join("\n");

  ctx.reply(msg, MENU);
});

bot.hears("📌 الأوردرات المحجوزة", async (ctx) => {
  const today = DateTime.now().setZone(TZ).toFormat("yyyy-MM-dd");

  const res = await pool.query(
    `SELECT id, client_name, event_date, location, deposit
     FROM orders
     WHERE event_date >= $1
     ORDER BY event_date ASC`,
    [today]
  );

  if (res.rows.length === 0) {
    return ctx.reply("مفيش أوردرات محجوزة.", MENU);
  }

  const msg = res.rows
    .map(
      (r) =>
        `#${r.id} | ${r.client_name} | ${r.event_date} | ${r.location} | عربون: ${r.deposit}ج`
    )
    .join("\n");

  ctx.reply(msg, MENU);
});

// ====== ORDER FLOW ======
bot.on("text", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const msg = ctx.message.text;

  if (s.step === "client") {
    s.client = msg;
    s.step = "date";
    return ctx.reply("📅 اكتب تاريخ المناسبة (YYYY-MM-DD):", MENU);
  }

  if (s.step === "date") {
    s.date = msg;
    s.step = "location";
    return ctx.reply("📍 اكتب مكان المناسبة:", MENU);
  }

  if (s.step === "location") {
    s.location = msg;
    s.step = "details";
    return ctx.reply("📝 اكتب تفاصيل الأوردر:", MENU);
  }

  if (s.step === "details") {
    s.details = msg;
    s.step = "deposit";
    return ctx.reply("💰 اكتب قيمة العربون (جنيه):", MENU);
  }

  if (s.step === "deposit") {
    const deposit = parseInt(msg);
    if (isNaN(deposit)) {
      return ctx.reply("❌ اكتب رقم صحيح", MENU);
    }

    await pool.query(
      `INSERT INTO orders (created_by, client_name, event_date, location, details, deposit)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.from.id, s.client, s.date, s.location, s.details, deposit]
    );

    sessions.delete(ctx.from.id);

    return ctx.reply(
      `✅ تم تسجيل الأوردر\n\n` +
        `👤 ${s.client}\n📅 ${s.date}\n📍 ${s.location}\n💰 عربون: ${deposit}ج`,
      MENU
    );
  }
});

// ====== LAUNCH ======
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("Bot running...");
    initDb();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
