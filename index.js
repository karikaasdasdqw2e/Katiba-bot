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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ====== تخصصات الأعضاء ======
const SPECIALTIES = [
  "ليز",
  "شاشات",
  "دي جي",
  "استيدج",
  "تصوير وميكسر",
  "درون",
  "كوشه وديكور",
  "الجميع",
];

// ====== Menu ======
const MENU = Markup.keyboard([
  ["➕ إضافة أوردر جديد", "📋 الأوردرات المسجلة"],
  ["📌 الأوردرات المحجوزة", "ℹ️ مساعدة"],
]).resize();

const HELP =
  "أهلاً 👋\n\n" +
  "اختار من القايمة تحت 👇\n" +
  "➕ إضافة أوردر جديد\n" +
  "📋 الأوردرات المسجلة (قائمة + تفاصيل)\n" +
  "📌 الأوردرات المحجوزة (القادمة)\n\n" +
  "لو عايز تعدل تخصصاتك: /profile";

// ====== Sessions ======
const sessions = new Map(); // telegramId -> { step, ... }

// ===== Helpers =====
function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function isMenuText(t) {
  return [
    "➕ إضافة أوردر جديد",
    "📋 الأوردرات المسجلة",
    "📌 الأوردرات المحجوزة",
    "ℹ️ مساعدة",
  ].includes((t || "").trim());
}

function normalizeArabicDigitsToInt(input) {
  const normalized = String(input || "")
    .replace(/[^\d٠-٩]/g, "")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const n = parseInt(normalized, 10);
  return Number.isNaN(n) ? null : n;
}

// التاريخ يقبل: 15.12.2026 / 15/12/2026 / 15-12-2026 / 15/1/2026 / 15/01/2026
function parseDateFlexible(input) {
  if (!input) return null;
  const raw = String(input).trim();

  // ISO yyyy-mm-dd
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    return isValidDateParts(d, m, y) ? toISODate(y, m, d) : null;
  }

  const clean = raw.replace(/[.\-]/g, "/");
  const parts = clean.split("/").map((x) => x.trim());
  if (parts.length !== 3) return null;

  const d = Number(parts[0]);
  const m = Number(parts[1]);
  const y = Number(parts[2]);

  return isValidDateParts(d, m, y) ? toISODate(y, m, d) : null;
}

function isValidDateParts(d, m, y) {
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return false;
  if (y < 2020 || y > 2100) return false;
  const dt = DateTime.fromObject({ year: y, month: m, day: d }, { zone: TZ });
  return dt.isValid;
}

function toISODate(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Inline keyboards
function specialtiesKeyboard(selected = []) {
  const buttons = SPECIALTIES.map((s) =>
    Markup.button.callback(`${selected.includes(s) ? "✅" : "⬜"} ${s}`, `sp:${s}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback("✅ حفظ الاختيارات", "sp:done")]);
  return Markup.inlineKeyboard(rows);
}

function orderServicesKeyboard(selected = []) {
  const buttons = SPECIALTIES.map((s) =>
    Markup.button.callback(`${selected.includes(s) ? "✅" : "⬜"} ${s}`, `os:${s}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback("➡️ متابعة", "os:done")]);
  return Markup.inlineKeyboard(rows);
}

function ordersListInlineKeyboard(rows) {
  const buttons = rows.map((r) =>
    Markup.button.callback(
      `${r.client_name || "بدون اسم"} | ${r.event_date || "بدون تاريخ"}`,
      `order:${r.id}`
    )
  );
  return Markup.inlineKeyboard(buttons.map((b) => [b]));
}

// ===== DB init + migration safe =====
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      name TEXT,
      specialties TEXT DEFAULT '[]',
      is_registered BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
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
      created_at TIMESTAMP DEFAULT NOW(),
      datetime_iso TIMESTAMP,
      roles TEXT DEFAULT '[]'
    );
  `);

  // ensure columns if old schema
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS specialties TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_registered BOOLEAN;`);
  await pool.query(`UPDATE users SET specialties = COALESCE(specialties,'[]') WHERE specialties IS NULL;`);
  await pool.query(`UPDATE users SET is_registered = COALESCE(is_registered,false) WHERE is_registered IS NULL;`);

  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS roles TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS datetime_iso TIMESTAMP;`);
  await pool.query(`UPDATE orders SET roles = COALESCE(roles,'[]') WHERE roles IS NULL;`);
  await pool.query(`UPDATE orders SET datetime_iso = COALESCE(datetime_iso, NOW()) WHERE datetime_iso IS NULL;`);

  console.log("DB ready");
}

async function getUser(telegramId) {
  const res = await pool.query(
    `SELECT telegram_id, name, specialties, is_registered
     FROM users WHERE telegram_id = $1 LIMIT 1`,
    [telegramId]
  );
  return res.rows[0] || null;
}

async function upsertUserBasic(ctx) {
  const name =
    (ctx.from.first_name || "") +
    (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");
  await pool.query(
    `INSERT INTO users (telegram_id, name)
     VALUES ($1,$2)
     ON CONFLICT (telegram_id) DO UPDATE SET name = EXCLUDED.name`,
    [ctx.from.id, (name || "مستخدم").trim()]
  );
}

async function requireRegistered(ctx) {
  const u = await getUser(ctx.from.id);
  return u && u.is_registered;
}

// ===== Registration Flow =====
async function startRegistration(ctx) {
  sessions.set(ctx.from.id, { step: "reg_name" });
  return ctx.reply("👤 أول مرة بس: اكتب اسمك:", Markup.removeKeyboard());
}

bot.command("profile", async (ctx) => {
  await upsertUserBasic(ctx);
  const u = await getUser(ctx.from.id);
  if (!u || !u.is_registered) return startRegistration(ctx);

  const selected = safeJsonParse(u.specialties, []);
  sessions.set(ctx.from.id, { step: "reg_specialties", reg_selected: selected });
  return ctx.reply("🧩 عدّل تخصصاتك (تقدر تختار أكتر من واحد):", specialtiesKeyboard(selected));
});

// Handle registration specialty buttons
bot.action(/^sp:(.+)$/, async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s || s.step !== "reg_specialties") return ctx.answerCbQuery();

  const val = ctx.match[1];

  if (val === "done") {
    const selected = s.reg_selected || [];
    if (selected.length === 0) return ctx.answerCbQuery("اختار تخصص واحد على الأقل");

    await pool.query(
      `UPDATE users SET specialties = $1, is_registered = TRUE WHERE telegram_id = $2`,
      [JSON.stringify(selected), ctx.from.id]
    );

    sessions.delete(ctx.from.id);
    await ctx.answerCbQuery("تم");
    return ctx.reply("✅ تم التسجيل بنجاح. القايمة ظهرت تحت 👇", MENU);
  }

  const selected = new Set(s.reg_selected || []);
  if (selected.has(val)) selected.delete(val);
  else selected.add(val);

  s.reg_selected = [...selected];
  sessions.set(ctx.from.id, s);

  await ctx.editMessageReplyMarkup(specialtiesKeyboard(s.reg_selected).reply_markup);
  return ctx.answerCbQuery();
});

// ===== Start / Help =====
bot.start(async (ctx) => {
  await upsertUserBasic(ctx);
  const u = await getUser(ctx.from.id);
  if (!u || !u.is_registered) return startRegistration(ctx);
  return ctx.reply(HELP, MENU);
});

bot.hears("ℹ️ مساعدة", async (ctx) => {
  if (!(await requireRegistered(ctx))) return startRegistration(ctx);
  return ctx.reply(HELP, MENU);
});

// ===== Orders List =====
bot.hears("📋 الأوردرات المسجلة", async (ctx) => {
  if (!(await requireRegistered(ctx))) return startRegistration(ctx);

  const res = await pool.query(
    `SELECT id, client_name, event_date
     FROM orders ORDER BY id DESC LIMIT 20`
  );
  if (res.rows.length === 0) return ctx.reply("مفيش أوردرات مسجلة لسه ✅", MENU);

  return ctx.reply("📋 اختر أوردر للتفاصيل:", ordersListInlineKeyboard(res.rows));
});

bot.hears("📌 الأوردرات المحجوزة", async (ctx) => {
  if (!(await requireRegistered(ctx))) return startRegistration(ctx);

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

  if (res.rows.length === 0) return ctx.reply("مفيش أوردرات محجوزة قادمة حالياً ✅", MENU);
  return ctx.reply("📌 اضغط على أوردر للتفاصيل:", ordersListInlineKeyboard(res.rows));
});

// Order details by click
bot.action(/^order:(\d+)$/, async (ctx) => {
  if (!(await requireRegistered(ctx))) return ctx.answerCbQuery("سجّل الأول");

  const id = parseInt(ctx.match[1], 10);
  const res = await pool.query(
    `SELECT id, client_name, event_date, location, details, deposit, status, created_at, roles
     FROM orders WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (res.rows.length === 0) return ctx.answerCbQuery("مش موجود");

  const o = res.rows[0];
  const createdAt = o.created_at
    ? DateTime.fromJSDate(o.created_at).setZone(TZ).toFormat("yyyy-MM-dd HH:mm")
    : "—";
  const roles = safeJsonParse(o.roles, []);

  await ctx.answerCbQuery("تم");
  return ctx.reply(
    `📌 تفاصيل الأوردر (#${o.id})\n\n` +
      `👤 الزبون: ${o.client_name || "-"}\n` +
      `📅 التاريخ: ${o.event_date || "-"}\n` +
      `📍 المكان: ${o.location || "-"}\n` +
      `🧩 التخصصات: ${roles.length ? roles.join(" - ") : "-"}\n` +
      `📝 التفاصيل: ${o.details || "-"}\n` +
      `💰 العربون: ${o.deposit ?? 0} جنيه\n` +
      `📌 الحالة: ${o.status || "قيد المراجعة"}\n` +
      `🕘 اتسجل: ${createdAt}`,
    MENU
  );
});

// ===== Add Order (Services FIRST) =====
function startNewOrder(ctx) {
  sessions.set(ctx.from.id, { step: "order_services", order_services: [] });
  return ctx.reply("🧩 اختار التخصصات المطلوبة في الأوردر:", orderServicesKeyboard([]));
}

bot.hears("➕ إضافة أوردر جديد", async (ctx) => {
  if (!(await requireRegistered(ctx))) return startRegistration(ctx);
  return startNewOrder(ctx);
});

// Handle order services buttons
bot.action(/^os:(.+)$/, async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s || s.step !== "order_services") return ctx.answerCbQuery();

  const val = ctx.match[1];

  if (val === "done") {
    if (!s.order_services || s.order_services.length === 0)
      return ctx.answerCbQuery("اختار تخصص واحد على الأقل");

    // إذا اختار "الجميع" نخليها الوحيدة
    if (s.order_services.includes("الجميع")) s.order_services = ["الجميع"];

    s.step = "client";
    sessions.set(ctx.from.id, s);
    await ctx.editMessageText("🧑‍💼 اكتب اسم صاحب الفرح (الزبون):");
    return ctx.answerCbQuery("تم");
  }

  const selected = new Set(s.order_services || []);
  if (selected.has(val)) selected.delete(val);
  else selected.add(val);

  // لو اختار الجميع → امسح الباقي
  if (selected.has("الجميع")) {
    selected.clear();
    selected.add("الجميع");
  } else {
    selected.delete("الجميع");
  }

  s.order_services = [...selected];
  sessions.set(ctx.from.id, s);

  await ctx.editMessageReplyMarkup(orderServicesKeyboard(s.order_services).reply_markup);
  return ctx.answerCbQuery();
});

// ===== Text input flow for order =====
bot.on("text", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const msg = (ctx.message.text || "").trim();

  // لو ضغط زر من المنيو أثناء جلسة -> نلغي
  if (isMenuText(msg)) {
    sessions.delete(ctx.from.id);
    return;
  }

  if (s.step === "reg_name") {
    // تسجيل الاسم ثم اختيار التخصصات
    await pool.query(
      `UPDATE users SET name = $1 WHERE telegram_id = $2`,
      [msg, ctx.from.id]
    );
    s.step = "reg_specialties";
    s.reg_selected = [];
    sessions.set(ctx.from.id, s);
    return ctx.reply("🧩 اختار تخصصاتك (تقدر تختار أكتر من واحد):", specialtiesKeyboard([]));
  }

  // ===== Order steps =====
  if (s.step === "client") {
    s.client = msg;
    s.step = "date";
    sessions.set(ctx.from.id, s);
    return ctx.reply(
      "📅 اكتب تاريخ المناسبة بأي صيغة:\n15.12.2026\n15/12/2026\n15-12-2026\n15/1/2026\n15/01/2026"
    );
  }

  if (s.step === "date") {
    const parsed = parseDateFlexible(msg);
    if (!parsed) return ctx.reply("❌ تاريخ غير صحيح. مثال: 15/12/2026");
    s.date = parsed;
    s.step = "location";
    sessions.set(ctx.from.id, s);
    return ctx.reply("📍 اكتب مكان المناسبة (مدينة + اسم القاعة/المكان):");
  }

  if (s.step === "location") {
    s.location = msg;
    s.step = "details";
    sessions.set(ctx.from.id, s);
    return ctx.reply("📝 اكتب تفاصيل الأوردر:");
  }

  if (s.step === "details") {
    s.details = msg;
    s.step = "deposit";
    sessions.set(ctx.from.id, s);
    return ctx.reply("💰 اكتب قيمة العربون (جنيه مصري):");
  }

  if (s.step === "deposit") {
    const deposit = normalizeArabicDigitsToInt(msg);
    if (deposit === null || deposit < 0) return ctx.reply("❌ اكتب رقم صحيح (مثال: 500)");

    // حفظ الأوردر + roles + datetime_iso (للتوافق مع جداول قديمة)
    const roles = JSON.stringify(s.order_services || []);

    let insertedId = null;
    try {
      const ins = await pool.query(
        `INSERT INTO orders (created_by, client_name, event_date, location, details, deposit, status, datetime_iso, roles)
         VALUES ($1,$2,$3,$4,$5,$6,'قيد المراجعة', NOW(), $7)
         RETURNING id`,
        [ctx.from.id, s.client, s.date, s.location, s.details, deposit, roles]
      );
      insertedId = ins.rows[0].id;
    } catch (e) {
      console.error("DB INSERT ERROR:", e);
      sessions.delete(ctx.from.id);
      return ctx.reply("⚠️ حصلت مشكلة في حفظ الأوردر.");
    }

    // إشعار للأعضاء حسب التخصص (بدون Calendar دلوقتي)
    try {
      await notifyMembersBySpecialties({
        ctx,
        order: {
          id: insertedId,
          client_name: s.client,
          event_date: s.date,
          location: s.location,
          details: s.details,
          deposit,
          roles: safeJsonParse(roles, []),
        },
      });
    } catch (e) {
      console.error("Notify error:", e);
    }

    sessions.delete(ctx.from.id);

    return ctx.reply(
      `✅ تم تسجيل الأوردر (#${insertedId})\n\n` +
        `🧩 التخصصات: ${(s.order_services || []).join(" - ")}\n` +
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

// ===== Notification logic =====
async function notifyMembersBySpecialties({ ctx, order }) {
  const selected = order.roles || [];
  if (!selected.length) return;

  const res = await pool.query(
    `SELECT telegram_id, name, specialties
     FROM users
     WHERE is_registered = TRUE`
  );

  const targetIds = new Set();

  // لو "الجميع" مختارة في الأوردر -> ابعت للكل المسجل
  const orderAll = selected.includes("الجميع");

  for (const u of res.rows) {
    const userSpecs = safeJsonParse(u.specialties, []);
    const userAll = userSpecs.includes("الجميع");

    const match =
      orderAll ||
      userAll ||
      userSpecs.some((sp) => selected.includes(sp));

    if (match) targetIds.add(String(u.telegram_id));
  }

  if (targetIds.size === 0) return;

  const text =
    `📢 أوردر جديد (#${order.id})\n` +
    `🧩 التخصصات: ${selected.join(" - ")}\n` +
    `👤 الزبون: ${order.client_name}\n` +
    `📅 التاريخ: ${order.event_date}\n` +
    `📍 المكان: ${order.location}\n` +
    `💰 العربون: ${order.deposit} جنيه\n` +
    `📝 التفاصيل: ${order.details}`;

  // ابعت لكل واحد
  for (const tid of targetIds) {
    try {
      await ctx.telegram.sendMessage(tid, text);
    } catch {}
  }
}

// ===== Boot =====
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    console.log("Bot running...");
    initDb().catch((err) => console.error("DB error:", err));
 Pier
  } catch (e) {
    console.error("Fatal error:", e);
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
