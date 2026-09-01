import { Bot, type Context } from "grammy";
import { loadConfig } from "./config.js";
import {
  audioFormatFromMimeType,
  createOpenRouterClient,
  type LlmAttachment,
} from "./llm/openrouter.js";
import {
  buildAudioExtractionPrompt,
  buildEditPrompt,
  buildExtractionPrompt,
  buildPhotoExtractionPrompt,
  isDeleteRequest,
  parseLlmResponse,
  parseLlmResponseList,
} from "./spend/parse.js";
import {
  computeStats,
  formatStatsMessage,
  resolvePeriod,
  roundAmount,
} from "./spend/stats.js";
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
    "Send me a spend like “coffee with Anna 6.50” and I'll track it — " +
    "several in one message works too (“coffee 5, taxi 12”).\n" +
      `Use /list to see your last ${LIST_LIMIT} spends, ` +
      "/stats for this month's totals per tag (/stats week, /stats prev).\n" +
      "You can also send a photo of a receipt or a voice message (caption optional).\n" +
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

bot.command("stats", async (ctx) => {
  const period = resolvePeriod(ctx.match, new Date());
  if (!period) {
    await ctx.reply(
      "Usage: /stats (this month), /stats week (this week), /stats prev (last month)",
    );
    return;
  }
  const spends = store.listBetween(
    period.from.toISOString(),
    period.to.toISOString(),
  );
  await ctx.reply(formatStatsMessage(period.label, computeStats(spends)));
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const replyTo = ctx.message.reply_to_message;
  if (replyTo) {
    await handleCorrection(ctx, replyTo.message_id, text);
    return;
  }

  await extractAndSave(ctx, {
    prompt: buildExtractionPrompt(text),
    rawText: text,
    parseFailReply:
      "Couldn't parse that as a spend. Try something like “groceries 23.40”.",
  });
});

bot.on("message:photo", async (ctx) => {
  const caption = ctx.message.caption ?? "";
  let bytes: Buffer;
  try {
    bytes = await downloadTelegramFile(ctx);
  } catch (error) {
    console.error("photo download failed:", error);
    await ctx.reply("Couldn't download that photo, please try again.");
    return;
  }

  await extractAndSave(ctx, {
    prompt: buildPhotoExtractionPrompt(caption),
    // Telegram serves photos (as opposed to documents) as JPEG.
    attachment: {
      type: "image",
      dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
    },
    rawText: caption.trim() !== "" ? `[photo] ${caption}` : "[photo]",
    parseFailReply:
      "Couldn't read a spend from that photo. Try a clearer shot of the receipt, or add a caption like “groceries 23.40”.",
  });
});

bot.on(["message:voice", "message:audio"], async (ctx) => {
  const caption = ctx.message.caption ?? "";
  const media = ctx.message.voice ?? ctx.message.audio;
  if (!media) {
    throw new Error("voice/audio handler fired without voice or audio payload");
  }

  let bytes: Buffer;
  try {
    bytes = await downloadTelegramFile(ctx);
  } catch (error) {
    console.error("audio download failed:", error);
    await ctx.reply("Couldn't download that audio, please try again.");
    return;
  }

  // Telegram voice notes are OGG/Opus; mime_type is normally set, but fall
  // back per media kind if it's missing.
  const mimeType =
    media.mime_type ?? (ctx.message.voice ? "audio/ogg" : "audio/mpeg");
  await extractAndSave(ctx, {
    prompt: buildAudioExtractionPrompt(caption),
    attachment: {
      type: "audio",
      base64Data: bytes.toString("base64"),
      format: audioFormatFromMimeType(mimeType),
    },
    rawText: caption.trim() !== "" ? `[voice] ${caption}` : "[voice]",
    parseFailReply:
      "Couldn't hear a spend in that audio. Try saying e.g. “coffee six fifty”, or send it as text.",
  });
});

/**
 * Shared add flow for text and photo: LLM extract → validate → save → confirm.
 * A receipt photo may yield many spends; each gets its own confirmation
 * message so every item stays individually editable/deletable by reply.
 */
async function extractAndSave(
  ctx: Context,
  input: {
    prompt: string;
    attachment?: LlmAttachment;
    rawText: string;
    parseFailReply: string;
  },
): Promise<void> {
  const llmResponse = await completeOrNull(input.prompt, input.attachment);
  if (llmResponse === null) {
    await ctx.reply("Couldn't reach the parsing service, please try again.");
    return;
  }

  const result = parseLlmResponseList(llmResponse);
  if (!result.ok) {
    console.warn(`parse failed for "${input.rawText}": ${result.reason}`);
    await ctx.reply(input.parseFailReply);
    return;
  }

  const spends = store.insertMany(result.spends, input.rawText);
  console.log(
    `saved ${spends.length} spend(s): ${spends.map((s) => `#${s.id}`).join(", ")}`,
  );
  if (spends.length > 1) {
    const total = spends.reduce((sum, spend) => sum + spend.amount, 0);
    await ctx.reply(`Saved ${spends.length} items, total ${roundAmount(total)}:`);
  }
  // Sequential on purpose: confirmations must arrive in receipt order.
  for (const spend of spends) {
    const confirmation = await ctx.reply(`Saved: ${formatSpend(spend)}`);
    store.linkMessage(spend.id, confirmation.message_id);
  }
}

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/**
 * Downloads the current message's media (largest photo size / voice / audio)
 * from Telegram. We deliberately re-upload bytes to OpenRouter instead of
 * passing Telegram's file URL — that URL contains the bot token.
 */
async function downloadTelegramFile(ctx: Context): Promise<Buffer> {
  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram returned a file without file_path");
  }
  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`file download failed: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_MEDIA_BYTES) {
    throw new Error(`file too large: ${bytes.length} bytes`);
  }
  return bytes;
}

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
async function completeOrNull(
  prompt: string,
  attachment?: LlmAttachment,
): Promise<string | null> {
  try {
    return await llm.complete(prompt, attachment);
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
