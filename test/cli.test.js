import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readManagedKey } from "../dist/state.js";

const execFileAsync = promisify(execFile);
const cliPath = path.join(process.cwd(), "dist", "cli.js");
const telegramMockPath = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "mock-telegram.mjs")).href;
const BOT_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

function cleanEnvironment() {
  const env = { ...process.env };
  delete env.TELEGRAM_NOTIF_CONFIG;
  delete env.TELEGRAM_NOTIF_CONFIG_FILE;
  delete env.TELEGRAM_MCP_DISCOVERY_ENABLED;
  delete env.TELEGRAM_MCP_HOST;
  delete env.TELEGRAM_MCP_PORT;
  delete env.TELEGRAM_MCP_ALLOWED_HOSTS;
  delete env.TELEGRAM_MCP_ALLOWED_ORIGINS;
  return env;
}

async function connectLocalClient(configPath, args, env = cleanEnvironment()) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "serve", ...args, "--config", configPath],
    env,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "local-discovery-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  return client;
}

test("CLI creates and rotates administrator keys for a disabled bootstrap config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-notif-cli-admin-"));
  const configPath = path.join(directory, "targets.json");
  const env = cleanEnvironment();
  try {
    await writeFile(configPath, JSON.stringify({
      targets: {},
      discovery: {
        enabled: false,
        bots: { setup: { bot: "valid_bot", token: "${BOT_TOKEN}" } },
      },
    }));

    const first = await execFileAsync(process.execPath, [
      cliPath, "keygen", "--admin", "--config", configPath,
    ], { env });
    const firstKey = first.stdout.match(/tnm_[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(firstKey);
    const document = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(document.discovery.adminKeySha256, createHash("sha256").update(firstKey).digest("hex"));
    assert.equal(document.discovery.bots.setup.token, "${BOT_TOKEN}");

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "keygen", "--admin", "--config", configPath], { env }),
      (error) => error.code === 1 && /already exists/.test(error.stderr),
    );
    const second = await execFileAsync(process.execPath, [
      cliPath, "keygen", "--admin", "--rotate", "--config", configPath,
    ], { env });
    const secondKey = second.stdout.match(/tnm_[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(secondKey);
    assert.notEqual(firstKey, secondKey);
    const rotated = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(rotated.discovery.adminKeySha256, createHash("sha256").update(secondKey).digest("hex"));
    assert.equal(JSON.stringify(rotated).includes(secondKey), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local discovery uses a separate operator process and respects the enable override", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-notif-cli-stdio-"));
  const configPath = path.join(directory, "targets.json");
  let project;
  let operator;
  try {
    await writeFile(configPath, JSON.stringify({
      targets: { alerts: { bot: "valid_bot", token: BOT_TOKEN, chatId: 123 } },
      discovery: {
        enabled: true,
        bots: { setup: { bot: "valid_bot", token: BOT_TOKEN } },
      },
    }), { mode: 0o600 });

    project = await connectLocalClient(configPath, ["--target", "alerts"]);
    operator = await connectLocalClient(configPath, ["--discovery"]);
    assert.deepEqual((await project.listTools()).tools.map((tool) => tool.name), ["send_notification"]);
    assert.deepEqual((await operator.listTools()).tools.map((tool) => tool.name), ["discover_chats"]);
    await assert.rejects(
      project.callTool({
        name: "discover_chats",
        arguments: { source: "bot", name: "setup", confirmNoOtherPoller: true },
      }),
      /Tool discover_chats not found/,
    );
    const unconfirmed = await operator.callTool({
      name: "discover_chats",
      arguments: { source: "bot", name: "setup", confirmNoOtherPoller: false },
    });
    assert.equal(unconfirmed.isError, true);
    const extraToken = await operator.callTool({
      name: "discover_chats",
      arguments: { source: "bot", name: "setup", confirmNoOtherPoller: true, token: BOT_TOKEN },
    });
    assert.equal(extraToken.isError, true);
    assert.equal(JSON.stringify(extraToken).includes(BOT_TOKEN), false);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "serve", "--discovery", "--config", configPath], {
        env: { ...cleanEnvironment(), TELEGRAM_MCP_DISCOVERY_ENABLED: "false" },
        timeout: 5000,
      }),
      (error) => error.code === 1 && /Discovery is disabled/.test(error.stderr),
    );
  } finally {
    await project?.close();
    await operator?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("check reports when an enabled bootstrap config has no notification targets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-notif-cli-check-"));
  const configPath = path.join(directory, "targets.json");
  try {
    await writeFile(configPath, JSON.stringify({
      targets: {},
      discovery: { enabled: true, bots: { setup: { bot: "valid_bot", token: BOT_TOKEN } } },
    }), { mode: 0o600 });
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "check", "--config", configPath], {
        env: cleanEnvironment(),
      }),
      (error) => error.code === 1 && /No notification targets are configured/.test(error.stderr),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI initializes and starts an empty administrator-only hosted service", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-notif-cli-http-"));
  const configPath = path.join(directory, "targets.json");
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  let child;
  let client;
  try {
    let output = "";
    child = spawn(process.execPath, [cliPath, "serve", "--http", "--initialize", "--config", configPath], {
      env: {
        ...cleanEnvironment(),
        TELEGRAM_MCP_HOST: "127.0.0.1",
        TELEGRAM_MCP_PORT: String(port),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hosted bootstrap did not start.")), 5000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Hosted bootstrap exited with ${code}: ${output}`));
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("listening on")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const document = JSON.parse(await readFile(configPath, "utf8"));
    const adminKey = { key: await readManagedKey(configPath, document.discovery.adminKeySha256) };
    assert.equal(document.discovery.enabled, true);
    assert.deepEqual(document.targets, {});
    assert.equal(output.includes(adminKey.key), false);
    assert.deepEqual(await (await fetch(`${baseUrl}/healthz`)).json(), { status: "ok" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      fetch: (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${adminKey.key}`);
        return fetch(url, { ...init, headers });
      },
    });

    client = new Client(
      { name: "bootstrap-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["discover_chats"]);
  } finally {
    await client?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI init and administrator retrieval do not need bot secrets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-notif-cli-init-"));
  const configPath = path.join(directory, "config.json");
  const env = cleanEnvironment();
  try {
    const initialized = await execFileAsync(process.execPath, [
      cliPath, "init", "--hosted", "--config", configPath,
    ], { env });
    assert.match(initialized.stdout, /config.json/);
    assert.doesNotMatch(initialized.stdout + initialized.stderr, /tnm_[A-Za-z0-9_-]{43}/);
    const document = JSON.parse(await readFile(configPath, "utf8"));
    document.targets.alerts = { bot: "valid_bot", token: "${UNAVAILABLE_TOKEN}" };
    await writeFile(configPath, JSON.stringify(document));

    const revealed = await execFileAsync(process.execPath, [
      cliPath, "admin-key", "show", "--config", configPath,
    ], { env });
    const key = revealed.stdout.trim();
    assert.match(key, /^tnm_[A-Za-z0-9_-]{43}$/);
    assert.equal(createHash("sha256").update(key).digest("hex"), document.discovery.adminKeySha256);
    assert.equal(revealed.stderr.includes(key), false);
    assert.match(revealed.stderr, /secret/i);
    const again = await execFileAsync(process.execPath, [
      cliPath, "init", "--hosted", "--config", configPath,
    ], { env });
    assert.doesNotMatch(again.stdout + again.stderr, /tnm_[A-Za-z0-9_-]{43}/);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), document);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI discovery matches operator MCP metadata and blocks pending-target sends", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-notif-cli-discover-"));
  const configPath = path.join(directory, "config.json");
  const env = cleanEnvironment();
  const run = (args, overrides = {}) => execFileAsync(process.execPath, [
    "--import", telegramMockPath, cliPath, ...args, "--config", configPath,
  ], { env: { ...env, ...overrides }, timeout: 5000 });
  let operator;
  try {
    await writeFile(configPath, JSON.stringify({
      targets: {
        pending: { bot: "valid_bot", token: BOT_TOKEN },
        ready: { bot: "valid_bot", token: BOT_TOKEN, chatId: -1001234567890 },
      },
      discovery: { enabled: true },
    }), { mode: 0o600 });
    const result = await run(["discover", "--target", "pending", "--confirm-no-other-poller"]);
    assert.deepEqual(JSON.parse(result.stdout), {
      bot: "valid_bot",
      chats: [{ chatId: -1001234567890, type: "supergroup", title: "Setup chat", threadIds: [42] }],
      updatesScanned: 1,
      mayHaveMore: false,
    });
    assert.equal((result.stdout + result.stderr).includes(BOT_TOKEN), false);
    operator = await connectLocalClient(configPath, ["--discovery"], {
      ...env, NODE_OPTIONS: `--import="${telegramMockPath}"`,
    });
    const mcp = await operator.callTool({
      name: "discover_chats",
      arguments: { source: "target", name: "pending", confirmNoOtherPoller: true },
    });
    assert.deepEqual(mcp.structuredContent, JSON.parse(result.stdout));
    await assert.rejects(
      run(["discover", "--target", "pending"]),
      (error) => error.code === 1 && /confirm-no-other-poller/.test(error.stderr),
    );
    await assert.rejects(
      run(["discover", "--target", "ready", "--confirm-no-other-poller"], {
        TELEGRAM_MCP_DISCOVERY_ENABLED: "false",
        TELEGRAM_NOTIF_CONFIG: JSON.stringify({
          targets: { ready: { bot: "valid_bot", token: BOT_TOKEN, chatId: -1001234567890 } },
          discovery: { enabled: true },
        }),
      }),
      (error) => error.code === 1 && /Discovery is disabled/.test(error.stderr),
    );
    for (const args of [
      ["check", "--target", "pending"],
      ["check"],
      ["test-send", "pending"],
      ["serve", "--target", "pending"],
    ]) {
      await assert.rejects(run(args), (error) => error.code === 1 && /has no chatId/.test(error.stderr));
    }
    const checked = await run(["check", "--target", "ready"]);
    assert.match(checked.stdout, /Verified ready/);
    const delivered = await run(["test-send", "ready"]);
    assert.match(delivered.stdout, /Delivered test message/);
  } finally {
    await operator?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
