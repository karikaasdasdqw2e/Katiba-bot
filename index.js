const { Telegraf } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply("أهلاً 👋 أنا بوت Katiba Events\nابعت كلمة id عشان تعرف Telegram ID بتاعك")
);

bot.hears("id", (ctx) =>
  ctx.reply(`Telegram ID بتاعك هو:\n${ctx.from.id}`)
);

bot.launch();
console.log("Bot running...");
