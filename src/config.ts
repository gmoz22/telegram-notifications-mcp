import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { protectPrivatePath, readManagedKey, replaceManagedKey } from "./state.js";

export interface BotConfig {
  bot: string;
  token: string;
}

export interface TargetConfig extends BotConfig {
  chatId: number;
  threadId?: number;
}

export interface SetupTargetConfig extends BotConfig {
  chatId?: number;
  threadId?: number;
}

export interface ClientConfig {
  target: string;
  keySha256: string;
}

export interface DiscoveryConfig {
  enabled: boolean;
  adminKeySha256?: string;
  bots?: Record<string, BotConfig>;
}

export interface NotificationConfig {
  targets: Record<string, SetupTargetConfig>;
  clients?: Record<string, ClientConfig>;
  discovery?: DiscoveryConfig;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  return platform === "win32"
    ? path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"),
      "telegram-notifs-mcp", "config.json")
    : path.join(home, ".config", "telegram-notifs-mcp", "config.json");
}

export const DEFAULT_CONFIG_PATH = defaultConfigPath();

async function fileExists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw new ConfigurationError(`Cannot inspect configuration path "${filename}".`);
  }
}

export async function resolveConfigPath(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const explicit = options.configPath ?? env.TELEGRAM_NOTIF_CONFIG_FILE;
  if (explicit !== undefined) return path.resolve(explicit);
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const canonical = defaultConfigPath(env, platform, home);
  const pathApi = platform === "win32" ? path.win32 : path;
  const candidates = [
    canonical,
    pathApi.join(home, ".config", "telegram-notifs-mcp", "targets.json"),
  ];
  const exists = await Promise.all(candidates.map(fileExists));
  const found = candidates.filter((_candidate, index) => exists[index]);
  if (found.length > 1) {
    throw new ConfigurationError(`Multiple default configuration files exist (${found.join(", ")}); select one with --config.`);
  }
  return found[0] ?? canonical;
}

export function requireReadyTarget(config: NotificationConfig, name: string): TargetConfig {
  if (!Object.hasOwn(config.targets, name)) {
    throw new ConfigurationError(`Target "${name}" does not exist in the config.`);
  }
  const target = config.targets[name];
  if (target.chatId === undefined) {
    throw new ConfigurationError(`Target "${name}" has no chatId. Complete discovery before sending.`);
  }
  if (!Number.isSafeInteger(target.chatId) || target.chatId === 0) {
    throw new ConfigurationError(`Target "${name}" has an invalid chatId.`);
  }
  return { ...target, chatId: target.chatId };
}

export function requireDiscoveryBot(
  config: NotificationConfig,
  source: "target" | "bot",
  name: string,
): BotConfig {
  const available = source === "target" ? config.targets : config.discovery?.bots;
  if (!available || !Object.hasOwn(available, name)) {
    throw new ConfigurationError(
      `Unknown discovery ${source} "${name}". Add its bot and token to the config and restart.`,
    );
  }
  return available[name];
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN_PATTERN = /^[0-9]{5,}:[A-Za-z0-9_-]{20,}$/;
const KEY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ENV_REFERENCE_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const MAX_CONFIG_BYTES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateName(value: string, label: string): void {
  if (!NAME_PATTERN.test(value)) {
    throw new ConfigurationError(
      `${label} must use lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen.`,
    );
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new ConfigurationError(`${context} has an unsupported field "${unexpected}".`);
  }
}

function resolveToken(
  value: unknown,
  label: string,
  env: NodeJS.ProcessEnv,
  allowUnresolvedReference: boolean,
): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(`${label} must have a token string.`);
  }

  const reference = ENV_REFERENCE_PATTERN.exec(value);
  if (reference && allowUnresolvedReference) {
    return value;
  }
  const token = reference ? env[reference[1]] : value;
  if (!token) {
    throw new ConfigurationError(
      reference
        ? `Environment variable ${reference[1]} for ${label} is not set.`
        : `${label} has an empty token.`,
    );
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new ConfigurationError(
      `${label} has an invalid bot token or environment-variable reference.`,
    );
  }

  return token;
}

function parseBot(
  value: Record<string, unknown>,
  label: string,
  env: NodeJS.ProcessEnv,
  allowUnresolvedReference: boolean,
): BotConfig {
  if (
    typeof value.bot !== "string"
    || !/^@?[A-Za-z0-9_]{5,32}$/.test(value.bot)
  ) {
    throw new ConfigurationError(`${label} must have a valid bot username.`);
  }
  return {
    bot: value.bot.replace(/^@/, ""),
    token: resolveToken(value.token, label, env, allowUnresolvedReference),
  };
}

export function isDiscoveryEnabled(
  config: NotificationConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = env.TELEGRAM_MCP_DISCOVERY_ENABLED;
  if (override !== undefined && override !== "true" && override !== "false") {
    throw new ConfigurationError('TELEGRAM_MCP_DISCOVERY_ENABLED must be "true" or "false".');
  }
  return override === undefined ? config.discovery?.enabled === true : override === "true";
}

// Accepts this package's tnm_ keys and platform-generated secrets such as
// Coolify's SERVICE_PASSWORD_64_* (64 alphanumeric characters).
const ENVIRONMENT_ADMIN_KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export function environmentAdminKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.TELEGRAM_MCP_ADMIN_KEY;
  // Compose renders an unset ${VAR:-} as an empty string.
  if (key === undefined || key === "") return undefined;
  if (!ENVIRONMENT_ADMIN_KEY_PATTERN.test(key)) {
    throw new ConfigurationError(
      "TELEGRAM_MCP_ADMIN_KEY must be 32-256 letters, digits, '-' or '_'.",
    );
  }
  return key;
}

export function effectiveAdminKeySha256(
  config: NotificationConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = environmentAdminKey(env);
  return key === undefined
    ? config.discovery?.adminKeySha256
    : createHash("sha256").update(key).digest("hex");
}

export function parseConfig(
  json: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    allowUnresolvedTokenReferences?: boolean;
    allowEmptyTargets?: boolean;
    allowIncompleteTargets?: boolean;
  } = {},
): NotificationConfig {
  if (Buffer.byteLength(json) > MAX_CONFIG_BYTES) {
    throw new ConfigurationError("Configuration exceeds the 1 MB size limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConfigurationError("Configuration must be valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new ConfigurationError("Configuration must be a JSON object.");
  }
  assertOnlyKeys(parsed, ["targets", "clients", "discovery"], "Configuration");
  if (!isRecord(parsed.targets)) {
    throw new ConfigurationError('Configuration must contain a "targets" object.');
  }

  const config: NotificationConfig = { targets: {} };

  if (parsed.discovery !== undefined) {
    if (!isRecord(parsed.discovery)) {
      throw new ConfigurationError('"discovery" must be an object when provided.');
    }
    assertOnlyKeys(parsed.discovery, ["enabled", "adminKeySha256", "bots"], "Discovery");
    if (
      parsed.discovery.enabled !== undefined
      && typeof parsed.discovery.enabled !== "boolean"
    ) {
      throw new ConfigurationError('"discovery.enabled" must be a boolean.');
    }
    if (
      parsed.discovery.adminKeySha256 !== undefined
      && (typeof parsed.discovery.adminKeySha256 !== "string"
        || !KEY_HASH_PATTERN.test(parsed.discovery.adminKeySha256))
    ) {
      throw new ConfigurationError('"discovery.adminKeySha256" must be a lowercase SHA-256 key hash.');
    }

    const discovery: DiscoveryConfig = {
      enabled: parsed.discovery.enabled === true,
      ...(parsed.discovery.adminKeySha256 === undefined
        ? {}
        : { adminKeySha256: parsed.discovery.adminKeySha256 }),
    };
    if (parsed.discovery.bots !== undefined) {
      if (!isRecord(parsed.discovery.bots)) {
        throw new ConfigurationError('"discovery.bots" must be an object when provided.');
      }
      discovery.bots = {};
      for (const [name, value] of Object.entries(parsed.discovery.bots)) {
        validateName(name, "Discovery bot name");
        if (!isRecord(value)) {
          throw new ConfigurationError(`Discovery bot "${name}" must be an object.`);
        }
        assertOnlyKeys(value, ["bot", "token"], `Discovery bot "${name}"`);
        discovery.bots[name] = parseBot(
          value,
          `Discovery bot "${name}"`,
          env,
          options.allowUnresolvedTokenReferences ?? false,
        );
      }
    }
    config.discovery = discovery;
  }

  const discoveryEnabled = isDiscoveryEnabled(config, env);
  for (const [name, value] of Object.entries(parsed.targets)) {
    validateName(name, "Target name");
    if (!isRecord(value)) {
      throw new ConfigurationError(`Target "${name}" must be an object.`);
    }
    assertOnlyKeys(value, ["bot", "token", "chatId", "threadId"], `Target "${name}"`);
    const bot = parseBot(value, `Target "${name}"`, env, options.allowUnresolvedTokenReferences ?? false);
    if (value.chatId === undefined) {
      if (!discoveryEnabled && !options.allowIncompleteTargets) {
        throw new ConfigurationError(`Target "${name}" requires a chatId when discovery is disabled.`);
      }
    } else if (
      typeof value.chatId !== "number"
      || !Number.isSafeInteger(value.chatId)
      || value.chatId === 0
    ) {
      throw new ConfigurationError(`Target "${name}" must have a non-zero safe-integer chatId.`);
    }
    if (
      value.threadId !== undefined
      && (typeof value.threadId !== "number"
        || !Number.isSafeInteger(value.threadId)
        || value.threadId <= 0)
    ) {
      throw new ConfigurationError(`Target "${name}" threadId must be a positive safe integer.`);
    }
    config.targets[name] = {
      ...bot,
      ...(value.chatId === undefined ? {} : { chatId: value.chatId }),
      ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
    };
  }

  if (
    Object.keys(config.targets).length === 0
    && !options.allowEmptyTargets
    && !discoveryEnabled
  ) {
    throw new ConfigurationError(
      'Configuration must define a target, or enable discovery for setup.',
    );
  }

  if (parsed.clients !== undefined) {
    if (!isRecord(parsed.clients)) {
      throw new ConfigurationError('"clients" must be an object when provided.');
    }
    config.clients = {};
    const seenHashes = new Set<string>();

    for (const [name, value] of Object.entries(parsed.clients)) {
      validateName(name, "Client name");
      if (!isRecord(value)) {
        throw new ConfigurationError(`Client "${name}" must be an object.`);
      }
      assertOnlyKeys(value, ["target", "keySha256"], `Client "${name}"`);
      if (typeof value.target !== "string" || !Object.hasOwn(config.targets, value.target)) {
        throw new ConfigurationError(`Client "${name}" must reference an existing target.`);
      }
      if (typeof value.keySha256 !== "string" || !KEY_HASH_PATTERN.test(value.keySha256)) {
        throw new ConfigurationError(`Client "${name}" must have a lowercase SHA-256 key hash.`);
      }
      if (seenHashes.has(value.keySha256)) {
        throw new ConfigurationError("Each hosted client must have a unique API key.");
      }
      if (value.keySha256 === config.discovery?.adminKeySha256) {
        throw new ConfigurationError("The administrator key must differ from every client key.");
      }
      seenHashes.add(value.keySha256);
      config.clients[name] = {
        target: value.target,
        keySha256: value.keySha256,
      };
    }
  }

  return config;
}

export function createClientKey(): { key: string; keySha256: string } {
  const key = `tnm_${randomBytes(32).toString("base64url")}`;
  return {
    key,
    keySha256: createHash("sha256").update(key).digest("hex"),
  };
}

export async function loadConfig(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ config: NotificationConfig; source: "environment" | "file"; path?: string }> {
  const env = options.env ?? process.env;
  if (env.TELEGRAM_NOTIF_CONFIG !== undefined) {
    return {
      config: parseConfig(env.TELEGRAM_NOTIF_CONFIG, env),
      source: "environment",
    };
  }

  const configPath = await resolveConfigPath({ configPath: options.configPath, env });
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigurationError(
      `Cannot read config file "${configPath}". Create it from config.example.json or set TELEGRAM_NOTIF_CONFIG.`,
    );
  }

  return { config: parseConfig(contents, env), source: "file", path: configPath };
}

export async function writeClientKeyHash(options: {
  configPath?: string;
  clientName: string;
  targetName: string;
  rotate: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ key: string; configPath: string }> {
  const configPath = await resolveConfigPath(options);
  const { config, document } = await readKeyConfig(configPath, options.env, false);
  validateName(options.clientName, "Client name");
  validateName(options.targetName, "Target name");
  if (!Object.hasOwn(config.targets, options.targetName)) {
    throw new ConfigurationError(`Target "${options.targetName}" does not exist in the config.`);
  }
  if (config.clients && Object.hasOwn(config.clients, options.clientName) && !options.rotate) {
    throw new ConfigurationError(
      `Client "${options.clientName}" already exists. Use --rotate to revoke its current key.`,
    );
  }

  const generated = createClientKey();
  if (generated.keySha256 === effectiveAdminKeySha256(config, options.env ?? process.env)) {
    throw new ConfigurationError("Generated client key conflicts with the administrator key; retry keygen.");
  }
  const originalClients = isRecord(document.clients) ? document.clients : {};
  document.clients = {
    ...originalClients,
    [options.clientName]: {
      target: options.targetName,
      keySha256: generated.keySha256,
    },
  };
  await writeKeyConfig(configPath, document);
  return { key: generated.key, configPath };
}

export async function writeAdminKeyHash(options: {
  configPath?: string;
  rotate: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ key: string; configPath: string }> {
  if (environmentAdminKey(options.env ?? process.env) !== undefined) {
    throw new ConfigurationError(
      "TELEGRAM_MCP_ADMIN_KEY supplies the administrator key; rotate it in your deployment environment.",
    );
  }
  const configPath = await resolveConfigPath(options);
  const { config, document } = await readKeyConfig(configPath, options.env, true);
  if (config.discovery?.adminKeySha256 && !options.rotate) {
    throw new ConfigurationError("An administrator key already exists. Use --rotate to revoke it.");
  }

  const generated = createClientKey();
  if (Object.values(config.clients ?? {}).some((client) => client.keySha256 === generated.keySha256)) {
    throw new ConfigurationError("Generated administrator key conflicts with a client key; retry keygen.");
  }
  const originalDiscovery = isRecord(document.discovery) ? document.discovery : {};
  document.discovery = {
    ...originalDiscovery,
    adminKeySha256: generated.keySha256,
  };
  const existingManaged = config.discovery?.adminKeySha256
    ? await readManagedKey(configPath, config.discovery.adminKeySha256, false)
    : undefined;
  if (existingManaged) {
    await replaceManagedKey(configPath, generated.key, () => writeKeyConfig(configPath, document));
  } else {
    await writeKeyConfig(configPath, document);
  }
  return { key: generated.key, configPath };
}

async function readKeyConfig(
  configPath: string,
  env: NodeJS.ProcessEnv | undefined,
  allowEmptyTargets: boolean,
): Promise<{ config: NotificationConfig; document: Record<string, unknown> }> {
  let original: string;
  try {
    original = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigurationError(`Cannot read config file "${configPath}" for key generation.`);
  }
  const config = parseConfig(original, env, {
    allowUnresolvedTokenReferences: true,
    allowEmptyTargets,
    allowIncompleteTargets: true,
  });
  const document: unknown = JSON.parse(original);
  if (!isRecord(document)) {
    throw new ConfigurationError("Configuration must be a JSON object.");
  }
  return { config, document };
}

export async function writeKeyConfig(configPath: string, document: Record<string, unknown>): Promise<void> {
  const output = `${JSON.stringify(document, null, 2)}\n`;
  const temporaryPath = `${configPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await protectPrivatePath(temporaryPath);
    await handle.writeFile(output, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, configPath);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new ConfigurationError(`Could not safely update config file "${configPath}".`);
  }
}

export async function configFileIsWorldReadable(configPath: string): Promise<boolean> {
  if (process.platform === "win32") {
    return false;
  }
  const fileStat = await stat(configPath);
  return (fileStat.mode & 0o077) !== 0;
}
