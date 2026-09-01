import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { createOpenRouterClient } from "./llm/openrouter.js";
import { buildExtractionPrompt, parseLlmResponse } from "./spend/parse.js";
import { createSpendStore, type Spend } from "./spend/store.js";

const LIST_LIMIT = 10;

const config = loadConfig();
const store = createSpendStore(config.dbPath);
const llm = createOpenRouterClient({
  apiKey: config.openRouterApiKey,
  model: config.openRouterModel,
});
const bot = new Bot(config.telegramBotToken);

// Single-user bot: anyone but the owner gets a refusal and no processing.
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== config.ownerTelegramUserId) {
    console.warn(`rejected message from user ${ctx.from?.id ?? "<unknown>"}`);
    await ctx.reply("Sorry, this is a private bot.");
    return;
  }
  await next();
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Send me a spend like “coffee with Anna 6.50” and I'll track it.\n" +
      `Use /list to see your last ${LIST_LIMIT} spends.`,
  );
});

bot.command("list", async (ctx) => {
  const spends = store.listRecent(LIST_LIMIT);
  if (spends.length === 0) {
    await ctx.reply("No spends recorded yet.");
    return;
  }
  await ctx.reply(spends.map(formatSpend).join("\n"));
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  let llmResponse: string;
  try {
    llmResponse = await llm.complete(buildExtractionPrompt(text));
  } catch (error) {
    console.error("LLM request failed:", error);
    await ctx.reply("Couldn't reach the parsing service, please try again.");
    return;
  }

  const result = parseLlmResponse(llmResponse);
  if (!result.ok) {
    console.warn(`parse failed for "${text}": ${result.reason}`);
    await ctx.reply(
      "Couldn't parse that as a spend. Try something like “groceries 23.40”.",
    );
    return;
  }

  const spend = store.insert(result.spend, text);
  console.log(`saved spend #${spend.id}: ${spend.amount} ${spend.description}`);
  await ctx.reply(`Saved: ${formatSpend(spend)}`);
});

function formatSpend(spend: Spend): string {
  const date = spend.createdAt.slice(0, 10);
  return `${spend.amount} — ${spend.description} [${spend.tags.join(", ")}] ${date}`;
}

bot.catch((error) => {
  console.error("bot error:", error);
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

console.log("Starting bot (long polling)...");
void bot.start({
  onStart: (me) => console.log(`Bot running as @${me.username}`),
});
