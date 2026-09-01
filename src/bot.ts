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
  formatLimitUsage,
  LIMITS,
  limitsForTags,
  sumUnderLimit,
  weeklyLimitAmount,
} from "./spend/limits.js";
import {
  computeStats,
  formatStatsMessage,
  resolvePeriod,
  roundAmount,
} from "./spend/stats.js";
import { ruPlural } from "./ruPlural.js";
import { createSpendStore, type Spend } from "./spend/store.js";
import { tagLabel, type Tag } from "./spend/tags.js";

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
    await ctx.reply("Извините, это приватный бот.");
    return;
  }
  await next();
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Отправь мне трату, например «кофе с Аней 6.50», и я её запишу — " +
      "можно несколько в одном сообщении («кофе 5, такси 12»).\n" +
      `/list покажет последние ${LIST_LIMIT} трат, ` +
      "/stats — итоги месяца по тегам (/stats week, /stats prev).\n" +
      "Можно прислать фото чека или голосовое сообщение (подпись необязательна).\n" +
      "Чтобы изменить трату, ответь на подтверждение поправкой (например «на самом деле 7.50»), " +
      "чтобы удалить — ответь «удали».",
  );
});

bot.command("list", async (ctx) => {
  const spends = store.listRecent(LIST_LIMIT);
  if (spends.length === 0) {
    await ctx.reply("Трат пока нет.");
    return;
  }
  await ctx.reply(spends.map(formatSpend).join("\n"));
});

bot.command("stats", async (ctx) => {
  const period = resolvePeriod(ctx.match, new Date());
  if (!period) {
    await ctx.reply(
      "Использование: /stats — этот месяц, /stats week — эта неделя, /stats prev — прошлый месяц",
    );
    return;
  }
  const spends = store.listBetween(
    period.from.toISOString(),
    period.to.toISOString(),
  );
  const statsMessage = formatStatsMessage(period.label, computeStats(spends));
  // For week periods the allowance is the monthly limit scaled to 7 days, so
  // both views track the same pace off a single configured number.
  const limitLines = LIMITS.map((limit) => {
    const limitAmount =
      period.kind === "week"
        ? weeklyLimitAmount(limit, period.from)
        : limit.monthlyAmount;
    return `${limit.label}: ${formatLimitUsage(sumUnderLimit(limit, spends), limitAmount)}`;
  });
  const limitsBlock =
    limitLines.length > 0 ? `\n\nЛимиты:\n${limitLines.join("\n")}` : "";
  await ctx.reply(statsMessage + limitsBlock);
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
      "Не смог разобрать это как трату. Напиши, например, «продукты 23.40».",
  });
});

bot.on("message:photo", async (ctx) => {
  const caption = ctx.message.caption ?? "";
  let bytes: Buffer;
  try {
    bytes = await downloadTelegramFile(ctx);
  } catch (error) {
    console.error("photo download failed:", error);
    await ctx.reply("Не смог скачать фото, попробуй ещё раз.");
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
      "Не смог прочитать трату с этого фото. Попробуй более чёткий снимок чека или добавь подпись, например «продукты 23.40».",
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
    await ctx.reply("Не смог скачать аудио, попробуй ещё раз.");
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
      "Не расслышал трату в этом аудио. Скажи, например, «кофе шесть пятьдесят» или отправь текстом.",
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
    await ctx.reply("Не смог связаться с сервисом разбора, попробуй ещё раз.");
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
    const itemWord = ruPlural(spends.length, "позиция", "позиции", "позиций");
    await ctx.reply(`Сохранено ${spends.length} ${itemWord}, итого ${roundAmount(total)}:`);
  }
  // Sequential on purpose: confirmations must arrive in receipt order.
  for (const spend of spends) {
    const confirmation = await ctx.reply(`Сохранено: ${formatSpend(spend)}`);
    store.linkMessage(spend.id, confirmation.message_id);
  }
  await replyLimitStatus(
    ctx,
    spends.flatMap((spend) => spend.tags),
  );
}

/**
 * After a save/update touching a limited tag: one message with the affected
 * limits' month + week usage. The week allowance is derived from the monthly
 * limit, so both lines track the same pace.
 */
async function replyLimitStatus(
  ctx: { reply: (text: string) => Promise<unknown> },
  tags: readonly Tag[],
): Promise<void> {
  const limits = limitsForTags(tags);
  if (limits.length === 0) {
    return;
  }
  const now = new Date();
  const month = resolvePeriod("", now);
  const week = resolvePeriod("week", now);
  if (!month || !week) {
    throw new Error("unreachable: built-in stats periods failed to resolve");
  }
  const monthSpends = store.listBetween(
    month.from.toISOString(),
    month.to.toISOString(),
  );
  const weekSpends = store.listBetween(
    week.from.toISOString(),
    week.to.toISOString(),
  );
  const lines = limits.map(
    (limit) =>
      `${limit.label}: за месяц ${formatLimitUsage(sumUnderLimit(limit, monthSpends), limit.monthlyAmount)}, ` +
      `за неделю ${formatLimitUsage(sumUnderLimit(limit, weekSpends), weeklyLimitAmount(limit, week.from))}`,
  );
  await ctx.reply(lines.join("\n"));
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
      "Изменить или удалить трату можно, только ответив на моё сообщение «Сохранено:» или «Обновлено:».",
    );
    return;
  }

  if (isDeleteRequest(text)) {
    store.delete(spend.id);
    console.log(`deleted spend #${spend.id}`);
    await ctx.reply(`Удалено: ${formatSpend(spend)}`);
    return;
  }

  const llmResponse = await completeOrNull(buildEditPrompt(spend, text));
  if (llmResponse === null) {
    await ctx.reply("Не смог связаться с сервисом разбора, попробуй ещё раз.");
    return;
  }

  const result = parseLlmResponse(llmResponse);
  if (!result.ok) {
    console.warn(`edit parse failed for "${text}": ${result.reason}`);
    await ctx.reply(
      "Не смог разобрать поправку. Напиши, например, «на самом деле 7.50», «тег путешествия» или «удали».",
    );
    return;
  }

  const updated = store.update(spend.id, result.spend, text);
  console.log(`updated spend #${updated.id}: ${updated.amount} ${updated.description}`);
  const confirmation = await ctx.reply(`Обновлено: ${formatSpend(updated)}`);
  store.linkMessage(updated.id, confirmation.message_id);
  // Old + new tags: an edit that moves a spend out of a limit changes that
  // limit's usage too, so both sides get reported.
  await replyLimitStatus(ctx, [...spend.tags, ...updated.tags]);
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
  return `${spend.amount} — ${spend.description} [${spend.tags.map(tagLabel).join(", ")}] ${date}`;
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
