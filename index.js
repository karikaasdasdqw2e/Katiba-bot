const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const { DateTime } = require("luxon");

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL missing (add Postgres on Railway)");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

const TZ = "Africa/Cairo";

// Sessions in memory (لإنشاء الأوردر خطوة بخطوة)
const sessions = new Map();

// أدوار الفريق (هنربطهم بـ Telegram IDs بعدين)
const ROLES = ["دي جي", "ليزر", "شاشات واستيدج", "تصوير", "تصوير جوي"];

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      created_by BIGINT,
      client_name TEXT NOT NULL,
      datetime_iso TEXT NOT NULL,
      location TEXT NOT NULL,
      details TEXT NOT NULL,
      roles TEXT NOT NULL,           -- JSON string array
      status TEXT DEFAULT 'قيد المراجعة',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("DB ready");
}

function rolesKeyboard(selected = new Set()) {
  const buttons = ROLES.map(r =>
    Markup.button.callback(`${selected.has(r) ? "✅" : "⬜️"} ${r}`, `role:${r}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback("✅ تأكيد", "role:done")]);
  return Markup.inlineKeyboard(rows);
}

async function upsertUser(ctx) {
  const id = ctx.from.id;
  const name = (ctx.from.first_name || "") + (ctx.from.last_name ? ` ${ctx.from.last_name}` : "");
  await pool.query(
    `INSERT INTO users (telegram_id, name) VALUES ($1,$2)
     ON CONFLICT (telegram_id) DO UPDATE SET name = EXCLUDED.name`,
    [id, name.trim() || "مستخدم"]
  );
}

bot.start(async (ctx) => {
  await upsertUser(ctx);
  ctx.reply(
    "أهلاً 👋 أنا بوت Katiba Events\n\n" +
    "✅ اكتب: id عشان تعرف Telegram ID\n" +
    "✅ اكتب: /new عشان تسجل أوردر جديد\n" +
    "✅ اكتب: /last عشان تشوف آخر 5 أوردرات"
  );
});

bot.hears(/^id$/i, (ctx) => ctx.reply(`Telegram ID بتاعك هو:\n${ctx.from.id}`));

bot.command("new", async (ctx) => {
  await upsertUser(ctx);
  sessions.set(ctx.from.id, { step: "client", roles: new Set() });
  ctx.reply("تمام ✅ اكتب اسم العميل:");
});

bot.command("last", async (ctx) => {
  const res = await pool.query(
    `SELECT id, client_name, datetime_iso, location, status
     FROM orders ORDER BY id DESC LIMIT 5`
  );
  if (res.rows.length === 0) return ctx.reply("مفيش أوردرات لسه.");
  const lines = res.rows.map(r => {
    const dt = DateTime.fromISO(r.datetime_iso).setZone(TZ).toFormat("yyyy-MM-dd HH:mm");
    return `#${r.id} | ${r.client_name} | ${dt} | ${r.location} | ${r.status}`;
  });
  ctx.reply(lines.join("\n"));
});

bot.on("text", async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return;

  const msg = ctx.message.text.trim();

  if (s.step === "client") {
    s.clientName = msg;
    s.step = "datetime";
    sessions.set(ctx.from.id, s);
    return ctx.reply("اكتب تاريخ ووقت المناسبة بصيغة:\nYYYY-MM-DD HH:mm\nمثال: 2026-01-20 19:30");
  }

  if (s.step === "datetime") {
    const dt = DateTime.fromFormat(msg, "yyyy-MM-dd HH:mm", { zone: TZ });
    if (!dt.isValid) return ctx.reply("الصيغة غلط. مثال: 2026-01-20 19:30");
    s.datetimeISO = dt.toISO();
    s.step = "location";
    sessions.set(ctx.from.id, s);
    return ctx.reply("اكتب مكان المناسبة (مدينة + اسم القاعة/المكان):");
  }

  if (s.step === "location") {
    s.location = msg;
    s.step = "details";
    sessions.set(ctx.from.id, s);
    return ctx.reply("اكتب تفاصيل الأوردر (نوع المناسبة + أي ملاحظات):");
  }

  if (s.step === "details") {
    s.details = msg;
    s.step = "roles";
    sessions.set(ctx.from.id, s);
    return ctx.reply("اختار الأدوار المحجوزة في الأوردر:", rolesKeyboard(s.roles));
  }
});

bot.action(/^role:(.+)$/, async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s || s.step !== "roles") return ctx.answerCbQuery();

  const val = ctx.match[1];

  if (val === "done") {
    if (s.roles.size === 0) return ctx.answerCbQuery("اختار دور واحد على الأقل");

    // Save order
    const rolesArr = [...s.roles];
    const insert = await pool.query(
      `INSERT INTO orders (created_by, client_name, datetime_iso, location, details, roles)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [ctx.from.id, s.clientName, s.datetimeISO, s.location, s.details, JSON.stringify(rolesArr)]
    );

    const orderId = insert.rows[0].id;
    sessions.delete(ctx.from.id);

    const dt = DateTime.fromISO(s.datetimeISO).setZone(TZ).toFormat("yyyy-MM-dd HH:mm");
    const text =
      `📌 أوردر جديد (#${orderId})\n` +
      `👤 العميل: ${s.clientName}\n` +
      `🗓️ الموعد: ${dt}\n` +
      `📍 المكان: ${s.location}\n` +
      `🧩 الأدوار: ${rolesArr.join(" - ")}\n` +
      `📝 التفاصيل: ${s.details}\n` +
      `💷 العملة: جنيه مصري فقط`;

    // حاليا: بنأكد لك انت إن كل شيء اتسجل
    await ctx.editMessageText("✅ تم حفظ الأوردر في قاعدة البيانات.");
    await ctx.reply(text);

    // بعد ما تبعت IDs الفريق هنرسل تلقائي للمشاركين حسب الأدوار
    return ctx.answerCbQuery("تم");
  }

  if (s.roles.has(val)) s.roles.delete(val);
  else s.roles.add(val);

  sessions.set(ctx.from.id, s);
  await ctx.editMessageReplyMarkup(rolesKeyboard(s.roles).reply_markup);
  return ctx.answerCbQuery();
});

initDb()
  .then(() => bot.launch({ dropPendingUpdates: true }))
  .then(() => console.log("Bot running..."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
