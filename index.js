const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const { DateTime } = require("luxon");

// ===== ENV =====
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

// جلسات إضافة الأوردر
const sessions = new Map();

// ===== MENU (Reply Keyboard) =====
const MENU = Markup.keyboard([
  ["➕ إضافة أوردر جديد", "📋 الأوردرات المسجلة"],
  ["📌 الأوردرات المحجوزة", "ℹ️ مساعدة"],
]).resize();

const HELP =
  "أهلاً 👋 أنا بوت Katiba Events\n\n" +
  "اختار من القايمة تحت 👇\n" +
  "➕ إضافة أوردر جديد\n" +
  "📋 الأوردرات المسجلة (قائمة + تفاصيل)\n" +
  "📌 الأوردرات المحجوزة (القادمة)\n\n" +
  "لمعرفة Telegram ID اكتب: id";

// ====== Helpers ======
function isMenuText(t) {
  return [
    "➕ إضافة أوردر جديد",
    "📋 الأوردرات المسجلة",
    "📌 الأوردرات المحجوزة",
    "ℹ️ مساعدة",
  ].includes((t || "").trim());
}

function normalizeArabicDigitsToInt(input) {
  // يقبل: ٥٠٠ / 500 / 500ج / ٥٠٠ جنيه
  const normalized = String(input || "")
    .replace(/[^\d٠-٩]/g, "")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const n = parseInt(normalized, 10);
  return Number.isNaN(n) ? null : n;
}

function parseDateFlexible(input) {
  // يقبل:
  // 15.12.2026 / 15/12/2026 / 15-12-2026 / 15/1/2026 / 15/01/2026
  // وكمان يقبل ISO: 2026-12-15
  if (!input) return null;
  const raw = String(input).trim();

  // ISO yyyy-mm-dd
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    if (!isValidDateParts(d, m, y)) return null;
    return toISODate(y, m, d);
  }

  // dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy (مع شهر برقم واحد أو اتنين)
  const clean = raw.replace(/[.\-]/g, "/");
  const parts = clean.split("/").map((x) => x.trim());
  if (parts.length !== 3) return null;

  const d = Number(parts[0]);
  const m = Number(parts[1]);
  const y = Number(parts[2]);

  if (!isValidDateParts(d, m, y)) return null;
  return toISODate(y, m, d);
}

function isValidDateParts(d, m, y) {
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return false;
  if (y < 2020 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;

  // تحقق فعلي باستخدام DateTime
  const dt = DateTime.fromObject({ year: y, month: m, day: d }, { zone: TZ });
  return dt.isValid;
}

function toISODate(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function ordersListInlineKeyboard(rows) {
  const buttons = rows.map((r) =>
    Markup.button.callback(
      `${r.client_name || "بدون اسم"} | ${r.event_date || "بدون تاريخ"}`,
      `order:${r.id}`
    )
  );
  const keyboard = buttons.map((b) => [b]);
  return Markup.inlineKeyboard(keyboard);
}

function startNewOrder(ctx) {
  sessions.set(ctx.from.id, { step: "client" });
  return ctx.reply("🧑‍💼 اكتب اسم صاحب الفرح (الزبون):", MENU);
}

async function upsertUser(ctx) {
  const name =
    (ctx.from.first_name || "") +
    (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");
  await pool.query(
    `INSERT INTO users (telegram_id, name)
     VALUES ($1,$2)
     ON CONFLICT (telegram_id) DO UPDATE SET name=$2`,
    [ctx.from.id, (name || "مستخدم").trim()]
  );
}

// ===== DB INIT + SAFE MIGRATION =====
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      name TEXT
    );
  `);

  // اعمل جدول orders لو مش موجود (أقل شكل مطلوب)
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
      created_at TIMESTAMP DEFAULT NOW(),
      datetime_iso TIMESTAMP,
      roles TEXT DEFAULT '[]'
    );
  `);

  // لو الجدول قديم، نضيف الأعمدة الناقصة بدون ما نكسر أي حاجة
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by BIGINT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_name TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS event_date TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS location TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS details TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS datetime_iso TIMESTAMP;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS roles TEXT;`);

  // defaults لو null
  await pool.query(`UPDATE orders SET status = COALESCE(status,'قيد المراجعة') WHERE status IS NULL;`);
  await pool.query(`UPDATE orders SET roles = COALESCE(roles,'[]') WHERE roles IS NULL;`);
  await pool.query(`UPDATE orders SET datetime_iso = COALESCE(datetime_iso, NOW()) WHERE datetime_iso IS NULL;`);

  console.log("DB ready");
}

// ===== MENU HANDLERS =====
bot.start(async (ctx) => {
  try {
    await upsertUser(ctx);
  } catch (e) {
    console.error("upsertUser error:", e);
  }
  return ctx.reply(HELP, MENU);
});

bot.hears(/^id$/i, (ctx) =>
  ctx.reply(`Telegram ID بتاعك:\n${ctx.from.id}`, MENU)
);

bot.hears("ℹ️ مساعدة", (ctx) => ctx.reply(HELP, MENU));

bot.hears("➕ إضافة أوردر جديد", (ctx) => startNewOrder(ctx));

bot.hears("📋 الأوردرات المسجلة", async (ctx) => {
  const res = await pool.query(
    `SELECT id, client_name, event_date
     FROM orders
     ORDER BY id DESC
     LIMIT 20`
  );

  if (res.rows.length === 0) {
    return ctx.reply("مفيش أوردرات مسجلة لسه ✅", MENU);
  }

  return ctx.reply(
    "📋 اختر أوردر عشان تشوف التفاصيل:",
    ordersListInlineKeyboard(res.rows)
  );
});

bot.hears("📌 الأوردرات المحجوزة", async (ctx) => {
  const today = DateTime.now().setZone(TZ).toFormat("yyyy-MM-dd");

  const res = await pool.query(
    `SELECT id, client_name, event_date
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

  return ctx.reply(
    "📌 الأوردرات المحجوزة (القادمة) — اضغط على الأوردر للتفاصيل:",
    ordersListInlineKeyboard(res.rows)
  );
});

// ===== CLICK ORDER -> DETAILS =====
bot.action(/^order:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);

  const res = await pool.query(
    `SELECT id, client_name, event_date, location, details, deposit, status, created_at
     FROM orders
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  if (res.rows.length === 0) {
    await ctx.answerCbQuery("الأوردر مش موجود");
    return;
  }

  const o = res.rows[0];
  const createdAt = o.created_at
    ? DateTime.fromJSDate(o.created_at).setZone(TZ).toFormat("yyyy-MM-dd HH:mm")
    : "غير معروف";

  const msg =
    `📌 تفاصيل الأوردر (#${o.id})\n\n` +
    `👤 الزبون: ${o.client_name || "-"}\n` +
    `📅 التاريخ: ${o.event_date || "-"}\n` +
    `📍 المكان: ${o.location || "-"}\n` +
    `📝 التفاصيل: ${o.details || "-"}\n` +
    `💰 العربون: ${o.deposit ?? 0} جنيه\n` +
    `📌 الحالة: ${o.status || "قيد المراجعة"}\n` +
    `🕘 اتسجل: ${createdAt}`;

  await ctx.answerCbQuery("تم");
  return ctx.reply(msg, MENU);
});

// ===== ORDER FLOW (TEXT INPUT) =====
bot.on("text", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const msg = (ctx.message.text || "").trim();

  // لو ضغط زر من المنيو أثناء إدخال الأوردر -> نلغي الجلسة
  if (isMenuText(msg)) {
    sessions.delete(ctx.from.id);
    return; // hears هيتعامل مع الزر
  }

  if (s.step === "client") {
    s.client = msg;
    s.step = "date";
    sessions.set(ctx.from.id, s);
    return ctx.reply(
      "📅 اكتب تاريخ المناسبة بأي صيغة من دول:\n" +
        "15.12.2026\n15/12/2026\n15-12-2026\n15/1/2026\n15/01/2026",
      MENU
    );
  }

  if (s.step === "date") {
    const parsed = parseDateFlexible(msg);
    if (!parsed) {
      return ctx.reply("❌ تاريخ غير صحيح. مثال: 15/12/2026", MENU);
    }
    s.date = parsed; // نخزن ISO: YYYY-MM-DD
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
    const deposit = normalizeArabicDigitsToInt(msg);
    if (deposit === null || deposit < 0) {
      return ctx.reply("❌ اكتب العربون كرقم صحيح (مثال: 500)", MENU);
    }

    try {
      // مهم: نملأ datetime_iso و roles تلقائيًا عشان قواعد قديمة NOT NULL
      await pool.query(
        `INSERT INTO orders (created_by, client_name, event_date, location, details, deposit, status, datetime_iso, roles)
         VALUES ($1,$2,$3,$4,$5,$6,'قيد المراجعة', NOW(), '[]')`,
        [ctx.from.id, s.client, s.date, s.location, s.details, deposit]
      );
    } catch (e) {
      console.error("DB INSERT ERROR:", e);
      sessions.delete(ctx.from.id);
      return ctx.reply("⚠️ حصلت مشكلة في حفظ الأوردر. راجع الأعمدة/القيود في قاعدة البيانات.", MENU);
    }

    sessions.delete(ctx.from.id);
    return ctx.reply(
      `✅ تم تسجيل الأوردر\n\n` +
        `👤 الزبون: ${s.client}\n` +
        `📅 التاريخ: ${s.date}\n` +
        `📍 المكان: ${s.location}\n` +
        `📝 التفاصيل: ${s.details}\n` +
        `💰 العربون: ${deposit} جنيه\n` +
        `📌 الحالة: قيد المراجعة`,
      MENU
    );
  }
});

// ===== BOOT =====
(async () => {
  try {
    // امسح أي Webhook قديم
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    // شغّل البوت (Polling)
    await bot.launch({ dropPendingUpdates: true });
    console.log("Bot running...");

    // جهز DB في الخلفية
    initDb().catch((err) => console.error("DB error:", err));
  } catch (e) {
    console.error("Fatal error:", e);
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
