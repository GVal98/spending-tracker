import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { createOpenRouterClient } from "./llm/openrouter.js";
import {
  buildEditPrompt,
  buildExtractionPrompt,
  isDeleteRequest,
  parseLlmResponse,
} from "./spend/parse.js";
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
      `Use /list to see your last ${LIST_LIMIT} spends.\n` +
      "Reply to a confirmation with a correction (e.g. “actually 7.50”) to edit, " +
      "or with “delete” to remove that spend.",
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
  const replyTo = ctx.message.reply_to_message;
  if (replyTo) {
    await handleCorrection(ctx, replyTo.message_id, text);
    return;
  }

  const llmResponse = await completeOrNull(buildExtractionPrompt(text));
  if (llmResponse === null) {
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
  const confirmation = await ctx.reply(`Saved: ${formatSpend(spend)}`);
  store.linkMessage(spend.id, confirmation.message_id);
});

/** Edit or delete flow: the user replied to one of our confirmation messages. */
async function handleCorrection(
  ctx: { reply: (text: string) => Promise<{ message_id: number }> },
  repliedToMessageId: number,
  text: string,
): Promise<void> {
  const spend = store.findByMessageId(repliedToMessageId);
  if (!spend) {
    await ctx.reply(
      "I can only edit or delete when you reply to one of my “Saved:” or “Updated:” messages.",
    );
    return;
  }

  if (isDeleteRequest(text)) {
    store.delete(spend.id);
    console.log(`deleted spend #${spend.id}`);
    await ctx.reply(`Deleted: ${formatSpend(spend)}`);
    return;
  }

  const llmResponse = await completeOrNull(buildEditPrompt(spend, text));
  if (llmResponse === null) {
    await ctx.reply("Couldn't reach the parsing service, please try again.");
    return;
  }

  const result = parseLlmResponse(llmResponse);
  if (!result.ok) {
    console.warn(`edit parse failed for "${text}": ${result.reason}`);
    await ctx.reply(
      "Couldn't parse that correction. Try e.g. “actually 7.50”, “tag as travel”, or “delete”.",
    );
    return;
  }

  const updated = store.update(spend.id, result.spend, text);
  console.log(`updated spend #${updated.id}: ${updated.amount} ${updated.description}`);
  const confirmation = await ctx.reply(`Updated: ${formatSpend(updated)}`);
  store.linkMessage(updated.id, confirmation.message_id);
}

/** Expected boundary failure (network/LLM down) → null; caller replies to user. */
async function completeOrNull(prompt: string): Promise<string | null> {
  try {
    return await llm.complete(prompt);
  } catch (error) {
    console.error("LLM request failed:", error);
    return null;
  }
}

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
