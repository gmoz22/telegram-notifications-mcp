#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { NotificationConfig } from "./config.js";
import {
  ConfigurationError,
  configFileIsWorldReadable,
  DEFAULT_CONFIG_PATH,
  environmentAdminKey,
  isDiscoveryEnabled,
  loadConfig,
  parseConfig,
  requireDiscoveryBot,
  requireReadyTarget,
  resolveConfigPath,
  writeAdminKeyHash,
  writeClientKeyHash,
} from "./config.js";
import { createHttpApp, listenHttp } from "./http.js";
import { initializeConfig } from "./init.js";
import { readManagedKey, StateError } from "./state.js";
import { createDiscoveryServer, createNotificationServer } from "./server.js";
import { discoverTelegramChats, sendTelegramMessage, TelegramError, verifyTelegramTarget } from "./telegram.js";

const HELP = `telegram-notifs-mcp - Telegram Bot notifications and operator discovery

Commands:
  init [--hosted] [--config <file>]                        Create private setup configuration
  admin-key show [--config <file>]                        Reveal a managed administrator key
  discover --target <name> --confirm-no-other-poller       Discover chat and forum topic IDs
  serve --target <name> [--label <name>] [--config <file>]  Run local stdio MCP
  serve --discovery [--config <file>]                      Run local operator discovery MCP
  serve --http [--config <file>]                           Run hosted HTTP MCP
  serve --http --initialize [--config <file>]             Initialize hosted state on first start
  check [--target <name>] [--config <file>]               Verify configured targets
  test-send <target> [--config <file>]                     Send one test message
  keygen --client <name> --target <name> [--rotate]        Create or rotate hosted API key
  keygen --admin [--rotate] [--config <file>]              Create or rotate administrator key
  help                                                     Show this help

Configuration:
  Default file: ${DEFAULT_CONFIG_PATH}
  TELEGRAM_NOTIF_CONFIG       Complete JSON config (takes precedence)
  TELEGRAM_NOTIF_CONFIG_FILE  Config file path
  TELEGRAM_MCP_DISCOVERY_ENABLED  Override discovery.enabled (true or false)
  TELEGRAM_MCP_ADMIN_KEY      Hosted administrator key (overrides the managed key)
`;

function parseCommandArgs(args: string[], options: Record<string, { type: "string" | "boolean" }>) {
  return parseArgs({
    args,
    options,
    allowPositionals: true,
    strict: true,
  });
}

function assertNoPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new ConfigurationError(`Unexpected argument for ${command}: "${positionals[0]}".`);
  }
}

async function warnIfConfigPermissionsAreLoose(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (loaded.source === "file" && loaded.path && await configFileIsWorldReadable(loaded.path)) {
    console.error(
      `Warning: config file "${loaded.path}" is readable by other users. Run chmod 600 on it.`,
    );
  }
}

function requireTarget(config: NotificationConfig, targetName: string) {
  return requireReadyTarget(config, targetName);
}

async function runCheck(config: NotificationConfig, selectedTarget?: string): Promise<void> {
  const names = selectedTarget ? [selectedTarget] : Object.keys(config.targets);
  if (names.length === 0) {
    throw new ConfigurationError("No notification targets are configured to check.");
  }
  const targets = names.map((name) => ({ name, target: requireTarget(config, name) }));
  for (const { name: targetName, target } of targets) {
    await verifyTelegramTarget(targetName, target);
    console.log(`Verified ${targetName} (@${target.bot}). No message sent.`);
  }
}

async function runTestSend(config: NotificationConfig, targetName: string): Promise<void> {
  const target = requireTarget(config, targetName);
  await verifyTelegramTarget(targetName, target);
  const messageId = await sendTelegramMessage({
    targetName,
    target,
    text: `Telegram notification setup test for target "${targetName}".`,
    format: "plain",
    silent: false,
  });
  console.log(`Delivered test message to "${targetName}" (message ${messageId}).`);
}

async function runLocalServer(options: {
  config: NotificationConfig;
  targetName: string;
  label?: string;
}): Promise<void> {
  requireTarget(options.config, options.targetName);
  const handle = serveStdio(() => createNotificationServer({
    config: options.config,
    targetName: options.targetName,
    clientName: options.label ?? options.targetName,
    prefix: options.label !== undefined,
  }));
  console.error(`telegram-notifs-mcp serving target "${options.targetName}" over stdio.`);
  const close = () => {
    void handle.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function runLocalDiscoveryServer(config: NotificationConfig): Promise<void> {
  if (!isDiscoveryEnabled(config)) {
    throw new ConfigurationError("Discovery is disabled in the configuration.");
  }
  const handle = serveStdio(() => createDiscoveryServer({ config }));
  console.error("telegram-notifs-mcp serving operator discovery over stdio.");
  const close = () => {
    void handle.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

async function runHttpServer(config: NotificationConfig): Promise<void> {
  const app = createHttpApp(config);
  const server = await listenHttp(app);
  const { host, port, handler } = app.locals.telegramMcp as {
    host: string;
    port: number;
    handler: { close: () => Promise<void> };
  };
  console.error(`telegram-notifs-mcp listening on ${host}:${port} (HTTP MCP at /mcp).`);

  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handler.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function runServe(args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, {
    config: { type: "string" },
    target: { type: "string" },
    label: { type: "string" },
    http: { type: "boolean" },
    discovery: { type: "boolean" },
    initialize: { type: "boolean" },
  });
  assertNoPositionals(parsed.positionals, "serve");
  const isHttp = parsed.values.http === true;
  const isDiscovery = parsed.values.discovery === true;
  if (parsed.values.initialize && !isHttp) {
    throw new ConfigurationError("--initialize applies only to hosted mode. Use init for local setup.");
  }
  const targetName = typeof parsed.values.target === "string" ? parsed.values.target : undefined;
  const label = typeof parsed.values.label === "string" ? parsed.values.label : undefined;
  const configPath = typeof parsed.values.config === "string" ? parsed.values.config : undefined;
  if (isHttp && (targetName || label)) {
    throw new ConfigurationError("--target and --label apply only to local stdio mode.");
  }
  if (isDiscovery && (isHttp || targetName || label)) {
    throw new ConfigurationError("--discovery cannot be combined with --http, --target, or --label.");
  }
  if (!isHttp && !isDiscovery && !targetName) {
    throw new ConfigurationError("Local stdio mode requires --target <name>.");
  }

  if (parsed.values.initialize && process.env.TELEGRAM_NOTIF_CONFIG === undefined) {
    const initialized = await initializeConfig({ configPath, hosted: true });
    if (initialized.created) console.error(`Created setup config at ${initialized.configPath}.`);
    if (initialized.keyPath) console.error(`Administrator secret stored at ${initialized.keyPath}; use admin-key show to retrieve it.`);
    if (environmentAdminKey() !== undefined) console.error("Using the administrator key from TELEGRAM_MCP_ADMIN_KEY.");
  }
  const loaded = await loadConfig({ configPath });
  await warnIfConfigPermissionsAreLoose(loaded);
  if (isHttp) {
    await runHttpServer(loaded.config);
  } else if (isDiscovery) {
    await runLocalDiscoveryServer(loaded.config);
  } else {
    if (!targetName) {
      throw new ConfigurationError("Local stdio mode requires --target <name>.");
    }
    await runLocalServer({
      config: loaded.config,
      targetName,
      label,
    });
  }
}

async function runConfigCommand(command: "check" | "test-send", args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, {
    config: { type: "string" },
    ...(command === "check" ? { target: { type: "string" as const } } : {}),
  });
  const configPath = typeof parsed.values.config === "string" ? parsed.values.config : undefined;
  const loaded = await loadConfig({ configPath });
  await warnIfConfigPermissionsAreLoose(loaded);

  if (command === "check") {
    assertNoPositionals(parsed.positionals, "check");
    await runCheck(loaded.config, typeof parsed.values.target === "string" ? parsed.values.target : undefined);
    return;
  }

  if (parsed.positionals.length !== 1) {
    throw new ConfigurationError("test-send requires exactly one target name.");
  }
  await runTestSend(loaded.config, parsed.positionals[0]);
}

async function runKeygen(args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, {
    config: { type: "string" },
    client: { type: "string" },
    target: { type: "string" },
    rotate: { type: "boolean" },
    admin: { type: "boolean" },
  });
  assertNoPositionals(parsed.positionals, "keygen");
  if (process.env.TELEGRAM_NOTIF_CONFIG !== undefined) {
    throw new ConfigurationError("keygen updates a JSON file; unset TELEGRAM_NOTIF_CONFIG and use --config.");
  }

  const isAdmin = parsed.values.admin === true;
  const clientName = typeof parsed.values.client === "string" ? parsed.values.client : undefined;
  const targetName = typeof parsed.values.target === "string" ? parsed.values.target : undefined;
  if (isAdmin && (clientName || targetName)) {
    throw new ConfigurationError("keygen --admin cannot be combined with --client or --target.");
  }
  if (!isAdmin && (!clientName || !targetName)) {
    throw new ConfigurationError("keygen requires --client <name> and --target <name>.");
  }
  const configPath = await resolveConfigPath({
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
  });
  if (isAdmin) {
    const result = await writeAdminKeyHash({
      configPath,
      rotate: parsed.values.rotate === true,
    });
    console.log(`Administrator key (shown once): ${result.key}`);
    console.log(`Stored only its SHA-256 hash in ${result.configPath}.`);
    return;
  }
  if (!clientName || !targetName) {
    throw new ConfigurationError("keygen requires --client <name> and --target <name>.");
  }
  const result = await writeClientKeyHash({
    configPath,
    clientName,
    targetName,
    rotate: parsed.values.rotate === true,
  });
  console.log(`Client key (shown once): ${result.key}`);
  console.log(`Stored only its SHA-256 hash in ${result.configPath}.`);
}

async function runInit(args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, { config: { type: "string" }, hosted: { type: "boolean" } });
  assertNoPositionals(parsed.positionals, "init");
  const result = await initializeConfig({
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
    hosted: parsed.values.hosted === true,
  });
  console.log(`${result.created ? "Created" : "Using existing"} config: ${result.configPath}`);
  if (result.keyPath) console.log(`Administrator secret file: ${result.keyPath}. Retrieve with admin-key show.`);
  console.log("Add named targets with bot and token. Omit chatId until discovery; restart after config edits.");
}

async function runShowAdminKey(args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, { config: { type: "string" } });
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "show") {
    throw new ConfigurationError("Use admin-key show to explicitly retrieve the stored administrator key.");
  }
  if (process.env.TELEGRAM_NOTIF_CONFIG !== undefined) {
    throw new ConfigurationError("Managed administrator-key retrieval requires a file configuration.");
  }
  if (environmentAdminKey() !== undefined) {
    throw new ConfigurationError(
      "The administrator key comes from TELEGRAM_MCP_ADMIN_KEY; view it in your deployment platform's environment settings.",
    );
  }
  const filename = await resolveConfigPath({
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
  });
  const config = parseConfig(await readFile(filename, "utf8"), process.env, {
    allowEmptyTargets: true, allowIncompleteTargets: true, allowUnresolvedTokenReferences: true,
  });
  if (!config.discovery?.adminKeySha256) throw new ConfigurationError("No administrator key is configured.");
  const key = await readManagedKey(filename, config.discovery.adminKeySha256);
  console.error("Secret output: store this key in the administrator MCP client's secure secret store, never in a prompt or deployment log.");
  console.log(key);
}

async function runDiscover(args: string[]): Promise<void> {
  const parsed = parseCommandArgs(args, {
    config: { type: "string" }, target: { type: "string" }, bot: { type: "string" },
    "confirm-no-other-poller": { type: "boolean" },
  });
  assertNoPositionals(parsed.positionals, "discover");
  if (parsed.values["confirm-no-other-poller"] !== true) {
    throw new ConfigurationError("Discovery requires --confirm-no-other-poller after checking no other consumer polls the bot.");
  }
  const name = typeof parsed.values.target === "string" ? parsed.values.target
    : typeof parsed.values.bot === "string" ? parsed.values.bot : undefined;
  if (!name || (parsed.values.target && parsed.values.bot)) {
    throw new ConfigurationError("Discover requires exactly one --target <name> or legacy --bot <name>.");
  }
  const loaded = await loadConfig({
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
  });
  if (!isDiscoveryEnabled(loaded.config)) throw new ConfigurationError("Discovery is disabled.");
  const bot = requireDiscoveryBot(loaded.config, parsed.values.target ? "target" : "bot", name);
  const result = await discoverTelegramChats({ botName: name, bot, confirmNoOtherPoller: true });
  console.log(JSON.stringify(result, null, 2));
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "serve") {
    await runServe(rest);
    return;
  }
  if (command === "init") {
    await runInit(rest);
    return;
  }
  if (command === "admin-key") {
    await runShowAdminKey(rest);
    return;
  }
  if (command === "discover") {
    await runDiscover(rest);
    return;
  }
  if (command === "check" || command === "test-send") {
    await runConfigCommand(command, rest);
    return;
  }
  if (command === "keygen") {
    await runKeygen(rest);
    return;
  }
  throw new ConfigurationError(`Unknown command "${command}". Run "telegram-notifs-mcp help".`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof ConfigurationError || error instanceof TelegramError || error instanceof StateError) {
    console.error(`telegram-notifs-mcp: ${error.message}`);
  } else {
    console.error("telegram-notifs-mcp: an unexpected error occurred; no success was confirmed.");
  }
  process.exitCode = 1;
});
