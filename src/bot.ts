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
  buildItemEditPrompt,
  buildPhotoExtractionPrompt,
  isDeleteRequest,
  parseItemEditResponse,
  parseLlmResponse,
  parseLlmResponseList,
  splitPositionPrefix,
  type NumberedSpend,
  type SpendDraft,
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
  periodElapsedFraction,
  resolvePeriod,
  roundAmount,
} from "./spend/stats.js";
import { ruPlural } from "./ruPlural.js";
import { createSpendStore, type MessageItem, type Spend } from "./spend/store.js";
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
      "чтобы удалить — ответь «удали». Если в подтверждении несколько позиций, " +
      "укажи номер («2 удали», «3 на самом деле 700») или назови позицию словами («удали такси»).",
  );
});

bot.command("list", async (ctx) => {
  const spends = store.listRecent(LIST_LIMIT);
  if (spends.length === 0) {
    await ctx.reply("Трат пока нет.");
    return;
  }
  await ctx.reply(spends.map(formatSpendWithDate).join("\n"));
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
  const elapsed = periodElapsedFraction(period, new Date());
  const labelWidth = Math.max(...LIMITS.map((limit) => limit.label.length));
  const limitLines = LIMITS.map((limit) => {
    const limitAmount =
      period.kind === "week"
        ? weeklyLimitAmount(limit, period.from)
        : limit.monthlyAmount;
    const usage = formatLimitUsage(sumUnderLimit(limit, spends), limitAmount, elapsed);
    return `${limit.label.padEnd(labelWidth)} ${usage}`;
  });
  const limitsBlock =
    limitLines.length > 0 ? `\n\nЛимиты:\n${monospace(limitLines.join("\n"))}` : "";
  await ctx.reply(escapeHtml(statsMessage) + limitsBlock, { parse_mode: "HTML" });
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
 * A receipt photo may yield many spends; they share one numbered confirmation
 * message, and a reply addresses an item by its number (or by description).
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
  const confirmation = await ctx.reply(formatSaveConfirmation(spends));
  store.linkMessage(
    confirmation.message_id,
    spends.map((spend) => spend.id),
  );
  await replyLimitStatus(
    ctx,
    spends.flatMap((spend) => spend.tags),
  );
}

/**
 * After a save/update touching a limited tag: one monospace message with the
 * affected limits' month + week bars. The week allowance is derived from the
 * monthly limit, so both lines track the same pace.
 */
async function replyLimitStatus(ctx: ReplyContext, tags: readonly Tag[]): Promise<void> {
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
  const monthElapsed = periodElapsedFraction(month, now);
  const weekElapsed = periodElapsedFraction(week, now);
  const blocks = limits.map((limit) =>
    [
      limit.label,
      `месяц  ${formatLimitUsage(sumUnderLimit(limit, monthSpends), limit.monthlyAmount, monthElapsed)}`,
      `неделя ${formatLimitUsage(sumUnderLimit(limit, weekSpends), weeklyLimitAmount(limit, week.from), weekElapsed)}`,
    ].join("\n"),
  );
  await ctx.reply(monospace(blocks.join("\n\n")), { parse_mode: "HTML" });
}

/** Wraps text in a Telegram monospace block (HTML parse mode); bars only line up in monospace. */
function monospace(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

type ReplyContext = {
  reply: (text: string, other?: { parse_mode: "HTML" }) => Promise<{ message_id: number }>;
};

const LLM_DOWN_REPLY = "Не смог связаться с сервисом разбора, попробуй ещё раз.";
const POSITION_HINT = "Укажи номер позиции, например «2 удали» или «3 на самом деле 700».";

/**
 * Edit or delete flow: the user replied to one of our confirmation messages.
 * A single-item message is corrected directly. In a numbered (receipt)
 * message the item comes from a leading number in the reply, otherwise the
 * model picks it from the correction text.
 */
async function handleCorrection(
  ctx: ReplyContext,
  repliedToMessageId: number,
  text: string,
): Promise<void> {
  const items = store.findByMessageId(repliedToMessageId);
  if (items.length === 0) {
    await ctx.reply(
      "Изменить или удалить трату можно, только ответив на моё сообщение «Сохранено:» или «Обновлено:».",
    );
    return;
  }

  if (items.length === 1) {
    const spend = items[0]!.spend;
    if (!spend) {
      await ctx.reply("Эта трата уже удалена.");
      return;
    }
    await correctSpend(ctx, spend, text);
    return;
  }

  const prefix = splitPositionPrefix(text, items.length);
  if (prefix) {
    const item = items.find((candidate) => candidate.position === prefix.position);
    if (!item?.spend) {
      await ctx.reply(`Позиция ${prefix.position} уже удалена.`);
      return;
    }
    await correctSpend(ctx, item.spend, prefix.rest);
    return;
  }

  await correctItemByDescription(ctx, items, text);
}

/** Correction aimed at one known spend: keyword delete, otherwise LLM edit. */
async function correctSpend(ctx: ReplyContext, spend: Spend, text: string): Promise<void> {
  if (isDeleteRequest(text)) {
    await deleteSpend(ctx, spend);
    return;
  }

  const llmResponse = await completeOrNull(buildEditPrompt(spend, text));
  if (llmResponse === null) {
    await ctx.reply(LLM_DOWN_REPLY);
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
  await updateSpend(ctx, spend, result.spend, text);
}

/** Correction to a numbered message without a number: the model picks the item. */
async function correctItemByDescription(
  ctx: ReplyContext,
  items: readonly MessageItem[],
  text: string,
): Promise<void> {
  const liveItems: NumberedSpend[] = [];
  const liveSpends = new Map<number, Spend>();
  for (const item of items) {
    if (item.spend) {
      liveItems.push({ position: item.position, spend: item.spend });
      liveSpends.set(item.position, item.spend);
    }
  }
  if (liveItems.length === 0) {
    await ctx.reply("Все позиции этого сообщения уже удалены.");
    return;
  }

  const llmResponse = await completeOrNull(buildItemEditPrompt(liveItems, text));
  if (llmResponse === null) {
    await ctx.reply(LLM_DOWN_REPLY);
    return;
  }

  const result = parseItemEditResponse(llmResponse, [...liveSpends.keys()]);
  if (!result.ok) {
    console.warn(`item edit failed for "${text}": ${result.reason} (${result.detail})`);
    await ctx.reply(
      result.reason === "ambiguous"
        ? `Не понял, о какой позиции речь. ${POSITION_HINT}`
        : `Не смог разобрать поправку. ${POSITION_HINT}`,
    );
    return;
  }

  const spend = liveSpends.get(result.position);
  if (!spend) {
    throw new Error(`unreachable: model position ${result.position} passed validation but has no spend`);
  }
  if (result.action === "delete") {
    await deleteSpend(ctx, spend);
    return;
  }
  await updateSpend(ctx, spend, result.spend, text);
}

async function deleteSpend(ctx: ReplyContext, spend: Spend): Promise<void> {
  store.delete(spend.id);
  console.log(`deleted spend #${spend.id}`);
  await ctx.reply(`Удалено: ${formatSpend(spend)}`);
}

async function updateSpend(
  ctx: ReplyContext,
  spend: Spend,
  draft: SpendDraft,
  rawText: string,
): Promise<void> {
  const updated = store.update(spend.id, draft, rawText);
  console.log(`updated spend #${updated.id}: ${updated.amount} ${updated.description}`);
  const confirmation = await ctx.reply(`Обновлено: ${formatSpend(updated)}`);
  store.linkMessage(confirmation.message_id, [updated.id]);
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

/**
 * Save confirmation: one line for a single spend, a numbered list (the
 * numbers are what replies refer to) plus a total for several.
 */
function formatSaveConfirmation(spends: readonly Spend[]): string {
  if (spends.length === 1) {
    return `Сохранено: ${formatSpend(spends[0]!)}`;
  }
  const total = spends.reduce((sum, spend) => sum + spend.amount, 0);
  const itemWord = ruPlural(spends.length, "позиция", "позиции", "позиций");
  const lines = spends.map((spend, index) => `${index + 1}. ${formatSpend(spend)}`);
  return [`Сохранено ${spends.length} ${itemWord}, итого ${roundAmount(total)}:`, ...lines].join("\n");
}

/** Confirmation format: no date, Telegram already shows the message date. */
function formatSpend(spend: Spend): string {
  return `${spend.amount} — ${spend.description} [${spend.tags.map(tagLabel).join(", ")}]`;
}

/** /list format: date included, since the list reply has no per-spend date. */
function formatSpendWithDate(spend: Spend): string {
  return `${formatSpend(spend)} ${spend.createdAt.slice(0, 10)}`;
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
