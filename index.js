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

// Public DB غالبًا يحتاج SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// جلسات إدخال الأوردر
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
  // users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // orders (schema الجديد)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      created_by BIGINT,
      client_name TEXT NOT NULL,
      event_date TEXT NOT NULL,   -- YYYY-MM-DD (بدون توقيت)
      location TEXT NOT NULL,
      details TEXT NOT NULL,
      deposit INTEGER NOT NULL,   -- EGP
      status TEXT DEFAULT 'قيد المراجعة',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // لو جدول قديم موجود، نضيف الأعمدة الناقصة بدون ما نكسر حاجة
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_date TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS location TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS details TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

  // Backfill: لو عندك عمود قديم datetime_iso نحاول نملأ event_date منه (اختياري)
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

  // لو فيه صفوف قديمة ناقصة status نثبتها
  await pool.query(`UPDATE orders SET status = COALESCE(status, 'قيد المراجعة') WHERE status IS NULL;`);

  console.log("DB ready");
}

// ====== Order flow (بدون وقت) ======
function startNewOrder(ctx) {
  sessions.set(ctx.from.id, { step: "client" });
  return ctx.reply("🧑‍💼 اكتب اسم صاحب الفرح (الزبون):", MENU);
}

// ====== Handlers ======
bot.start(async (ctx) => {
  try {
    await upsertUser(ctx);
  } catch (e) {
    console.error("upsertUser error:", e);
  }
  return ctx.reply(helpText(), MENU);
});

bot.hears(/^id$/i, (ctx) =>
  ctx.reply(`Telegram ID بتاعك هو:\n${ctx.from.id}`, MENU)
);

bot.hears("ℹ️ مساعدة", (ctx) => ctx.reply(helpText(), MENU));

bot.hears("➕ إضافة أوردر جديد", (ctx) => startNewOrder(ctx));
bot.command("new", (ctx) => startNewOrder(ctx)); // لو حد كتبها يدوي

// الأوردرات المحجوزة = القادمة + ليست (تم/ملغي/مرفوض)
bot.hears("📌 الأوردرات المحجوزة", async (ctx) => {
  const today = DateTime.now().setZone(TZ).toFormat("yyyy-MM-dd");

  const res = await pool.query(
    `SELECT id, client_name, event_date, location, status, deposit
     FROM orders
     WHERE event_date >= $1
       AND status NOT IN ('تم','ملغي','مرفوض')
     ORDER BY event_date ASC, id ASC
     LIMIT 20`,
    [today]
  );

  if (res.rows.length === 0) {
    return ctx.reply("مفيش أوردرات محجوزة قادمة حالياً ✅", MENU);
  }

  const lines = res.rows.map((r) => {
    const dep = Number.isFinite(r.deposit) ? r.deposit : (r.deposit ?? 0);
    return `#${r.id} | ${r.client_name} | ${r.event_date} | ${r.location} | ${r.status} | عربون: ${dep}ج`;
  });

  return ctx.reply("📌 الأوردرات المحجوزة (القادمة):\n\n" + lines.join("\n"), MENU);
});

// آخر 5 أوردرات
async function lastFive(ctx) {
  const res = await pool.query(
    `SELECT id, client_name, event_date, location, status, deposit
     FROM orders
     ORDER BY id DESC
     LIMIT 5`
  );
  if (res.rows.length === 0) return ctx.reply("مفيش أوردرات لسه.", MENU);

  const lines = res.rows.map((r) => {
    const dep = Number.isFinite(r.deposit) ? r.deposit : (r.deposit ?? 0);
    return `#${r.id} | ${r.client_name} | ${r.event_date} | ${r.location} | ${r.status} | عربون: ${dep}ج`;
  });

  return ctx.reply(lines.join("\n"), MENU);
}

bot.hears("🕘 آخر 5 أوردرات", (ctx) => lastFive(ctx));
bot.command("last", (ctx) => lastFive(ctx));

// إدخال نصوص أثناء جلسة /new
bot.on("text", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const msg = (ctx.message.text || "").trim();

  // لو ضغط زر من المنيو أثناء جلسة، نلغي الجلسة ونعتمد على hears
  if (["➕ إضافة أوردر جديد", "📌 الأوردرات المحجوزة", "🕘 آخر 5 أوردرات", "ℹ️ مساعدة"].includes(msg)) {
    sessions.delete(ctx.from.id);
    return;
  }

  if (s.step === "client") {
    s.clientName = msg;
    s.step = "date";
    sessions.set(ctx.from.id, s);
    return ctx.reply("📅 اكتب تاريخ المناسبة بصيغة:\nYYYY-MM-DD\nمثال: 2026-01-20", MENU);
  }

  if (s.step === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(msg)) {
      return ctx.reply("❌ الصيغة غلط. مثال: 2026-01-20", MENU);
    }
    s.eventDate = msg;
    s.step = "location";
    sessions.set(ctx.from.id, s);
    return ctx.reply("📍 اكتب مكان المناسبة (مدينة + اسم القاعة/المكان):", MENU);
  }

  if (s.step === "location") {
    s.location = msg;
    s.step = "details";
    sessions.set(ctx.from.id, s);
    return ctx.reply("📝 اكتب تفاصيل الأوردر (نوع المناسبة + أي ملاحظات):", MENU);
  }

  if (s.step === "details") {
    s.details = msg;
    s.step = "deposit";
    sessions.set(ctx.from.id, s);
    return ctx.reply("💰 اكتب قيمة العربون (جنيه مصري فقط):", MENU);
  }

  if (s.step === "deposit") {
    const deposit = parseInt(msg, 10);
    if (Number.isNaN(deposit) || deposit < 0) {
      return ctx.reply("❌ اكتب رقم صحيح للعربون (مثال: 2000)", MENU);
    }

    try {
      await pool.query(
        `INSERT INTO orders (created_by, client_name, event_date, location, details, deposit, status)
         VALUES ($1,$2,$3,$4,$5,$6,'قيد المراجعة')`,
        [ctx.from.id, s.clientName, s.eventDate, s.location, s.details, deposit]
      );
    } catch (e) {
      console.error("DB insert error:", e);
      sessions.delete(ctx.from.id);
      return ctx.reply("⚠️ حصلت مشكلة في حفظ الأوردر. جرّب تاني.", MENU);
    }

    sessions.delete(ctx.from.id);

    return ctx.reply(
      "✅ تم حفظ الأوردر في قاعدة البيانات\n\n" +
        `👤 الزبون: ${s.clientName}\n` +
        `📅 التاريخ: ${s.eventDate}\n` +
        `📍 المكان: ${s.location}\n` +
        `📝 التفاصيل: ${s.details}\n` +
        `💰 العربون: ${deposit} جنيه\n` +
        `📌 الحالة: قيد المراجعة`,
      MENU
    );
  }
});

// ====== Launch (تشغيل البوت فورًا + DB في الخلفية) ======
(async () => {
  try {
    // مهم: امسح أي Webhook قديم
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    // شغّل البوت فورًا
    await bot.launch();
    console.log("Bot running...");

    // جهّز قاعدة البيانات في الخلفية (عشان مايحصلش تعليق)
    initDb().catch((err) => console.error("DB error:", err));
  } catch (e) {
    console.error("Fatal error:", e);
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
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
