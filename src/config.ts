import "dotenv/config";

export interface Config {
  telegramBotToken: string;
  openRouterApiKey: string;
  openRouterModel: string;
  ownerTelegramUserId: number;
  dbPath: string;
}

/**
 * Loads config from the environment. Fails fast on anything missing or
 * malformed — the bot must never start half-configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const telegramBotToken = requireVar(env, "TELEGRAM_BOT_TOKEN");
  const openRouterApiKey = requireVar(env, "OPENROUTER_API_KEY");
  const openRouterModel = requireVar(env, "OPENROUTER_MODEL");
  const dbPath = requireVar(env, "DB_PATH");

  const ownerRaw = requireVar(env, "OWNER_TELEGRAM_USER_ID");
  const ownerTelegramUserId = Number(ownerRaw);
  if (!Number.isInteger(ownerTelegramUserId) || ownerTelegramUserId <= 0) {
    throw new Error(
      `OWNER_TELEGRAM_USER_ID must be a positive integer, got "${ownerRaw}"`,
    );
  }

  return {
    telegramBotToken,
    openRouterApiKey,
    openRouterModel,
    ownerTelegramUserId,
    dbPath,
  };
}

function requireVar(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
