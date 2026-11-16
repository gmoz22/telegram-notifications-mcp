import type { BotConfig, TargetConfig } from "./config.js";

type TelegramMethod = "getMe" | "getChat" | "sendMessage" | "getWebhookInfo" | "getUpdates";
type FetchImplementation = typeof fetch;

export interface DiscoveredChat {
  chatId: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  firstName?: string;
  threadIds?: number[];
}

export interface ChatDiscoveryResult {
  bot: string;
  chats: DiscoveredChat[];
  updatesScanned: number;
  mayHaveMore: boolean;
}

interface TelegramEnvelope {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
}

const TOKEN_PATTERN = /[0-9]{5,}:[A-Za-z0-9_-]{20,}/;
const CHAT_UPDATE_FIELDS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "message_reaction",
  "message_reaction_count",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "chat_boost",
  "removed_chat_boost",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

async function callTelegram(
  token: string,
  method: TelegramMethod,
  payload: Record<string, unknown>,
  fetchImpl: FetchImplementation,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TelegramError(
      method === "sendMessage"
        ? "Telegram sendMessage request failed or timed out; delivery is unconfirmed and was not retried."
        : `Telegram ${method} request failed or timed out; not retried.`,
    );
  }

  const invalidResponseMessage = method === "sendMessage"
    ? "Telegram returned an invalid response; delivery is unconfirmed."
    : `Telegram returned an invalid ${method} response.`;
  let envelope: TelegramEnvelope;
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new TelegramError(invalidResponseMessage);
    }
    envelope = body;
  } catch (error) {
    if (error instanceof TelegramError) {
      throw error;
    }
    throw new TelegramError(invalidResponseMessage);
  }

  if (!response.ok || envelope.ok !== true) {
    const status = response.status;
    if (method === "getUpdates" && status === 409) {
      throw new TelegramError(
        "Telegram rejected getUpdates (HTTP 409); a webhook or another update consumer may be active. Not retried.",
      );
    }
    const state = status >= 500 ? "did not confirm" : "rejected";
    throw new TelegramError(`Telegram ${state} ${method} (HTTP ${status}); not retried.`);
  }
  if (method === "getUpdates" ? !Array.isArray(envelope.result) : !isRecord(envelope.result)) {
    throw new TelegramError(`Telegram returned an invalid ${method} result.`);
  }

  return envelope.result;
}

async function verifyTelegramBot(
  label: string,
  bot: BotConfig,
  fetchImpl: FetchImplementation,
): Promise<void> {
  const result = await callTelegram(bot.token, "getMe", {}, fetchImpl);
  if (
    !isRecord(result)
    || result.is_bot !== true
    || typeof result.username !== "string"
    || result.username.toLowerCase() !== bot.bot.toLowerCase()
  ) {
    throw new TelegramError(`${label} token does not match the configured bot username.`);
  }
}

export async function verifyTelegramTarget(
  name: string,
  target: TargetConfig,
  fetchImpl: FetchImplementation = fetch,
): Promise<void> {
  await verifyTelegramBot(`Target "${name}"`, target, fetchImpl);

  const chat = await callTelegram(
    target.token,
    "getChat",
    { chat_id: target.chatId },
    fetchImpl,
  );
  if (
    !isRecord(chat)
    || chat.id !== target.chatId
    || !["private", "group", "supergroup", "channel"].includes(String(chat.type))
  ) {
    throw new TelegramError(`Target "${name}" is not a supported Telegram chat.`);
  }
  if (target.threadId !== undefined && (chat.type !== "supergroup" || chat.is_forum !== true)) {
    throw new TelegramError(`Target "${name}" has a topic ID but is not a forum supergroup.`);
  }
}

function safeChatLabel(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > 256) {
    throw new TelegramError("Telegram returned invalid chat metadata for discovery.");
  }
  if (TOKEN_PATTERN.test(value)) {
    return "[redacted]";
  }
  return value;
}

function addDiscoveredChat(
  event: Record<string, unknown>,
  chats: Map<number, DiscoveredChat>,
): void {
  const chat = event.chat;
  if (
    !isRecord(chat)
    || typeof chat.id !== "number"
    || !Number.isSafeInteger(chat.id)
    || chat.id === 0
    || (chat.type !== "private"
      && chat.type !== "group"
      && chat.type !== "supergroup"
      && chat.type !== "channel")
  ) {
    throw new TelegramError("Telegram returned invalid chat metadata for discovery.");
  }
  if (
    event.message_thread_id !== undefined
    && (typeof event.message_thread_id !== "number"
      || !Number.isSafeInteger(event.message_thread_id)
      || event.message_thread_id <= 0)
  ) {
    throw new TelegramError("Telegram returned an invalid forum topic ID for discovery.");
  }

  const title = safeChatLabel(chat.title);
  const firstName = safeChatLabel(chat.first_name);
  const username = chat.username === undefined
    ? undefined
    : safeChatLabel(chat.username);
  const discovered = chats.get(chat.id) ?? { chatId: chat.id, type: chat.type };
  discovered.type = chat.type;
  if (title !== undefined) discovered.title = title;
  if (username !== undefined) discovered.username = username;
  if (firstName !== undefined) discovered.firstName = firstName;
  if (chat.type === "supergroup" && typeof event.message_thread_id === "number") {
    discovered.threadIds ??= [];
    if (!discovered.threadIds.includes(event.message_thread_id)) {
      discovered.threadIds.push(event.message_thread_id);
    }
  }
  chats.set(chat.id, discovered);
}

export async function discoverTelegramChats(options: {
  botName: string;
  bot: BotConfig;
  confirmNoOtherPoller: boolean;
  fetchImpl?: FetchImplementation;
}): Promise<ChatDiscoveryResult> {
  if (options.confirmNoOtherPoller !== true) {
    throw new TelegramError("Confirm that no other process polls this bot before using discovery.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  await verifyTelegramBot(`Discovery bot "${options.botName}"`, options.bot, fetchImpl);
  const webhook = await callTelegram(options.bot.token, "getWebhookInfo", {}, fetchImpl);
  if (!isRecord(webhook) || typeof webhook.url !== "string") {
    throw new TelegramError("Telegram returned invalid webhook information for discovery.");
  }
  if (webhook.url !== "") {
    throw new TelegramError(
      "This bot has a webhook; getUpdates cannot be used. Obtain chat IDs from the existing webhook instead.",
    );
  }

  const updates = await callTelegram(
    options.bot.token,
    "getUpdates",
    { limit: 100, timeout: 0 },
    fetchImpl,
  );
  if (!Array.isArray(updates) || updates.length > 100) {
    throw new TelegramError("Telegram returned an invalid getUpdates result.");
  }

  const chats = new Map<number, DiscoveredChat>();
  for (const update of updates) {
    if (
      !isRecord(update)
      || typeof update.update_id !== "number"
      || !Number.isSafeInteger(update.update_id)
      || update.update_id <= 0
    ) {
      throw new TelegramError("Telegram returned an invalid update for discovery.");
    }
    for (const field of CHAT_UPDATE_FIELDS) {
      if (update[field] !== undefined) {
        if (!isRecord(update[field])) {
          throw new TelegramError("Telegram returned an invalid update for discovery.");
        }
        addDiscoveredChat(update[field], chats);
      }
    }
    if (update.callback_query !== undefined) {
      if (!isRecord(update.callback_query)) {
        throw new TelegramError("Telegram returned an invalid update for discovery.");
      }
      const message = update.callback_query.message;
      if (message !== undefined) {
        if (!isRecord(message)) {
          throw new TelegramError("Telegram returned an invalid update for discovery.");
        }
        addDiscoveredChat(message, chats);
      }
    }
  }

  return {
    bot: options.bot.bot,
    chats: [...chats.values()],
    updatesScanned: updates.length,
    mayHaveMore: updates.length === 100,
  };
}

export async function sendTelegramMessage(options: {
  targetName: string;
  target: TargetConfig;
  text: string;
  format: "plain" | "html";
  silent: boolean;
  fetchImpl?: FetchImplementation;
}): Promise<number> {
  const payload: Record<string, unknown> = {
    chat_id: options.target.chatId,
    text: options.text,
    disable_notification: options.silent,
    link_preview_options: { is_disabled: true },
  };
  if (options.target.threadId !== undefined) {
    payload.message_thread_id = options.target.threadId;
  }
  if (options.format === "html") {
    payload.parse_mode = "HTML";
  }

  const result = await callTelegram(
    options.target.token,
    "sendMessage",
    payload,
    options.fetchImpl ?? fetch,
  );
  if (
    !isRecord(result)
    || !isRecord(result.chat)
    || result.chat.id !== options.target.chatId
    || typeof result.message_id !== "number"
    || !Number.isSafeInteger(result.message_id)
    || result.message_id <= 0
  ) {
    throw new TelegramError(
      `Telegram did not confirm delivery to target "${options.targetName}" and a message ID.`,
    );
  }

  return result.message_id;
}
