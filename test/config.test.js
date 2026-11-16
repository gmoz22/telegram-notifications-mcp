import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createClientKey,
  isDiscoveryEnabled,
  parseConfig,
  writeAdminKeyHash,
  writeClientKeyHash,
} from "../dist/config.js";

const BOT_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

test("parses targets and expands only exact environment references", () => {
  const config = parseConfig(JSON.stringify({
    targets: {
      "dev-status": {
        bot: "@My_TG_Bot",
        token: "${TELEGRAM_TOKEN}",
        chatId: -1001234567890,
        threadId: 42,
      },
    },
  }), { TELEGRAM_TOKEN: BOT_TOKEN });

  assert.deepEqual(config.targets["dev-status"], {
    bot: "My_TG_Bot",
    token: BOT_TOKEN,
    chatId: -1001234567890,
    threadId: 42,
  });
});

test("rejects malformed or unsafe target and client configuration", () => {
  const invalid = [
    { targets: {} },
    { targets: { target: { bot: "bot", token: BOT_TOKEN, chatId: 1 } } },
    { targets: { target: { bot: "valid_bot", token: BOT_TOKEN, chatId: 0 } } },
    {
      targets: { target: { bot: "valid_bot", token: BOT_TOKEN, chatId: 1 } },
      clients: { app: { target: "missing", keySha256: "0".repeat(64) } },
    },
  ];

  for (const value of invalid) {
    assert.throws(() => parseConfig(JSON.stringify(value)));
  }
});

test("generates one-time keys without requiring token secrets in the keygen environment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-notifs-mcp-"));
  const configPath = path.join(directory, "targets.json");
  try {
    await writeFile(configPath, JSON.stringify({
      targets: {
        alerts: { bot: "My_TG_Bot", token: "${BOT_TOKEN}", chatId: 123 },
      },
    }));

    const result = await writeClientKeyHash({
      configPath,
      clientName: "project-one",
      targetName: "alerts",
      rotate: false,
    });
    const serialized = await readFile(configPath, "utf8");
    const config = parseConfig(serialized, { BOT_TOKEN });

    assert.match(result.key, /^tnm_[A-Za-z0-9_-]{43}$/);
    assert.equal(config.targets.alerts.token, BOT_TOKEN);
    assert.equal(JSON.parse(serialized).targets.alerts.token, "${BOT_TOKEN}");
    assert.equal(config.clients["project-one"].target, "alerts");
    assert.notEqual(serialized.includes(result.key), true);
    if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await assert.rejects(
      writeClientKeyHash({
        configPath,
        clientName: "project-one",
        targetName: "alerts",
        rotate: false,
      }),
      /already exists/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("key digest is reproducible and does not contain the API key", () => {
  const first = createClientKey();
  const second = createClientKey();
  assert.match(first.keySha256, /^[a-f0-9]{64}$/);
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.keySha256, first.key);
});

test("discovery defaults off and a strict environment override takes precedence", () => {
  const document = {
    targets: { alerts: { bot: "valid_bot", token: "${BOT_TOKEN}", chatId: 123 } },
    discovery: {
      enabled: false,
      bots: { setup: { bot: "@valid_bot", token: "${BOT_TOKEN}" } },
    },
  };
  const env = { BOT_TOKEN };
  const config = parseConfig(JSON.stringify(document), env);
  assert.equal(isDiscoveryEnabled(config, env), false);
  assert.deepEqual(config.discovery.bots.setup, { bot: "valid_bot", token: BOT_TOKEN });
  assert.equal(isDiscoveryEnabled(config, { ...env, TELEGRAM_MCP_DISCOVERY_ENABLED: "true" }), true);

  document.discovery.enabled = true;
  const enabled = parseConfig(JSON.stringify(document), env);
  assert.equal(isDiscoveryEnabled(enabled, env), true);
  assert.equal(isDiscoveryEnabled(enabled, { ...env, TELEGRAM_MCP_DISCOVERY_ENABLED: "false" }), false);
  for (const invalid of ["", "TRUE", "1", "yes"]) {
    assert.throws(
      () => parseConfig(JSON.stringify(document), { ...env, TELEGRAM_MCP_DISCOVERY_ENABLED: invalid }),
      /must be "true" or "false"/,
    );
  }
});

test("allows empty operator bootstrap only when discovery is enabled", () => {
  const bootstrap = {
    targets: {},
    discovery: {
      enabled: false,
      bots: { setup: { bot: "valid_bot", token: "${BOT_TOKEN}" } },
    },
  };
  assert.throws(() => parseConfig(JSON.stringify(bootstrap), { BOT_TOKEN }), /define a target/);
  const config = parseConfig(JSON.stringify(bootstrap), {
    BOT_TOKEN,
    TELEGRAM_MCP_DISCOVERY_ENABLED: "true",
  });
  assert.deepEqual(config.targets, {});
  assert.equal(config.discovery.bots.setup.token, BOT_TOKEN);

  bootstrap.discovery.enabled = true;
  assert.doesNotThrow(() => parseConfig(JSON.stringify(bootstrap), { BOT_TOKEN }));
  assert.throws(
    () => parseConfig(JSON.stringify(bootstrap), {
      BOT_TOKEN,
      TELEGRAM_MCP_DISCOVERY_ENABLED: "false",
    }),
    /define a target/,
  );
  bootstrap.discovery.bots = {};
  assert.doesNotThrow(() => parseConfig(JSON.stringify(bootstrap), { BOT_TOKEN }));
});

test("validates discovery settings and forbids sharing an administrator key with a project", () => {
  const key = createClientKey();
  const target = { bot: "valid_bot", token: BOT_TOKEN, chatId: 123 };
  const invalid = [
    { targets: { alerts: target }, discovery: { enabled: "true" } },
    { targets: { alerts: target }, discovery: { enabled: true, extra: true } },
    { targets: { alerts: target }, discovery: { bots: { "bad name": { bot: "valid_bot", token: BOT_TOKEN } } } },
    { targets: { alerts: target }, discovery: { adminKeySha256: "not-a-hash" } },
    {
      targets: { alerts: target },
      clients: { app: { target: "alerts", keySha256: key.keySha256 } },
      discovery: { adminKeySha256: key.keySha256 },
    },
    {
      targets: { alerts: target },
      clients: { app: { target: "constructor", keySha256: key.keySha256 } },
    },
  ];
  for (const document of invalid) {
    assert.throws(() => parseConfig(JSON.stringify(document), {}));
  }
});

test("generates and rotates an administrator key without resolving bot secrets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-notif-admin-"));
  const configPath = path.join(directory, "targets.json");
  try {
    await writeFile(configPath, JSON.stringify({
      targets: {},
      discovery: {
        enabled: false,
        bots: { setup: { bot: "valid_bot", token: "${BOT_TOKEN}" } },
      },
    }));

    const first = await writeAdminKeyHash({ configPath, rotate: false, env: {} });
    const serialized = await readFile(configPath, "utf8");
    const document = JSON.parse(serialized);
    assert.match(first.key, /^tnm_[A-Za-z0-9_-]{43}$/);
    assert.equal(document.discovery.adminKeySha256, createHash("sha256").update(first.key).digest("hex"));
    assert.equal(document.discovery.enabled, false);
    assert.equal(document.discovery.bots.setup.token, "${BOT_TOKEN}");
    assert.equal(serialized.includes(first.key), false);
    if (process.platform !== "win32") assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await assert.rejects(writeAdminKeyHash({ configPath, rotate: false, env: {} }), /already exists/);

    const second = await writeAdminKeyHash({ configPath, rotate: true, env: {} });
    assert.notEqual(first.key, second.key);
    const rotated = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(rotated.discovery.adminKeySha256, createHash("sha256").update(second.key).digest("hex"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
