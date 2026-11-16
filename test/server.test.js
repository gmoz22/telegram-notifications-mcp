import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import test from "node:test";
import { createClientKey, parseConfig } from "../dist/config.js";
import { authenticateBearer, createHttpApp } from "../dist/http.js";
import { RateLimitError, RateLimiter } from "../dist/rate-limiter.js";
import { createNotificationServer, validateNotificationText } from "../dist/server.js";

const BOT_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const targets = {
  "dev-status": {
    bot: "My_TG_Bot",
    token: BOT_TOKEN,
    chatId: 123456789,
  },
  "ops-alerts": {
    bot: "GMOZ_Ops_Bot",
    token: BOT_TOKEN,
    chatId: 987654321,
  },
};

async function startTestHttpServer(config, env = {}) {
  const app = createHttpApp(config, {
    TELEGRAM_MCP_HOST: "127.0.0.1",
    TELEGRAM_MCP_ALLOWED_HOSTS: "localhost,127.0.0.1",
    TELEGRAM_MCP_PORT: "3000",
    ...env,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await app.locals.telegramMcp.handler.close();
    },
  };
}

async function connectHttpClient(baseUrl, key, fetchImpl = fetch) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    fetch: (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${key}`);
      return fetchImpl(url, { ...init, headers });
    },
  });
  const client = new Client(
    { name: "discovery-test-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  return client;
}

function mockTelegram(requests) {
  return async (url, init) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = JSON.parse(init.body);
    requests.push({ method, payload });
    if (method === "getMe") {
      return Response.json({ ok: true, result: { is_bot: true, username: "My_TG_Bot" } });
    }
    if (method === "getWebhookInfo") {
      return Response.json({ ok: true, result: { url: "" } });
    }
    if (method === "sendMessage") {
      return Response.json({
        ok: true,
        result: { message_id: 23, chat: { id: payload.chat_id } },
      });
    }
    assert.equal(method, "getUpdates");
    return Response.json({
      ok: true,
      result: [{
        update_id: 1,
        message: { chat: { id: -998877, type: "group", title: "Setup chat" }, text: "private content" },
      }],
    });
  };
}

test("the MCP tool has no recipient argument and sends to the fixed target", async () => {
  const sent = [];
  const handler = createMcpHandler(() => createNotificationServer({
    config: { targets },
    targetName: "dev-status",
    clientName: "flight-radar",
    prefix: true,
    rateLimiter: new RateLimiter(() => 0, async () => {}),
    send: async (options) => {
      sent.push(options);
      return 31;
    },
  }));
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["send_notification"]);
    assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties), ["text", "format", "silent"]);

    const result = await client.callTool({
      name: "send_notification",
      arguments: { text: "Review complete", format: "plain" },
    });
    assert.equal(result.structuredContent.delivered, true);
    assert.equal(result.structuredContent.target, "dev-status");
    assert.equal(sent[0].text, "[flight-radar] Review complete");
    assert.equal(sent[0].target.chatId, 123456789);
  } finally {
    await client.close();
    await handler.close();
  }
});

test("hosted bearer keys resolve only to their configured client and target", () => {
  const generated = createClientKey();
  const config = {
    targets,
    clients: {
      "project-one": {
        target: "ops-alerts",
        keySha256: generated.keySha256,
      },
    },
  };
  const authenticated = authenticateBearer(`Bearer ${generated.key}`, config.clients);
  assert.equal(authenticated.clientName, "project-one");
  assert.equal(authenticated.authInfo.clientId, "project-one");
  assert.equal(authenticateBearer(`bearer ${generated.key}`, config.clients).clientName, "project-one");
  assert.equal(authenticateBearer(`Bearer ${generated.key}x`, config.clients), undefined);
  assert.equal(authenticateBearer(undefined, config.clients), undefined);
});

test("hosted setup blocks pending-target sends while ready projects continue", async () => {
  const pendingKey = createClientKey();
  const readyKey = createClientKey();
  const adminKey = createClientKey();
  const config = parseConfig(JSON.stringify({
    targets: {
      pending: { bot: "My_TG_Bot", token: BOT_TOKEN },
      ready: targets["dev-status"],
    },
    clients: {
      "pending-project": { target: "pending", keySha256: pendingKey.keySha256 },
      "ready-project": { target: "ready", keySha256: readyKey.keySha256 },
    },
    discovery: { enabled: true, adminKeySha256: adminKey.keySha256 },
  }));
  const requests = [];
  const originalFetch = globalThis.fetch;
  const telegramFetch = mockTelegram(requests);
  globalThis.fetch = (url, init) => new URL(url).hostname === "api.telegram.org"
    ? telegramFetch(url, init)
    : originalFetch(url, init);
  let server;
  let pending;
  let ready;
  try {
    server = await startTestHttpServer(config);
    pending = await connectHttpClient(server.baseUrl, pendingKey.key);
    ready = await connectHttpClient(server.baseUrl, readyKey.key);
    const blocked = await pending.callTool({
      name: "send_notification", arguments: { text: "Do not send" },
    });
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked), /has no chatId/);
    assert.equal(requests.length, 0);
    const delivered = await ready.callTool({
      name: "send_notification", arguments: { text: "Ready during discovery" },
    });
    assert.equal(delivered.structuredContent.delivered, true);
    assert.deepEqual(requests.map(({ method }) => method), ["sendMessage"]);
  } finally {
    await pending?.close();
    await ready?.close();
    await server?.close();
    globalThis.fetch = originalFetch;
  }
});

test("notification text rejects token-shaped values and messages above the character limit", () => {
  assert.throws(() => validateNotificationText("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), /bot-token/);
  assert.throws(() => validateNotificationText("🙂".repeat(4097)), /4096 characters/);
  assert.throws(() => validateNotificationText("  \n"), /must not be empty/);
  assert.doesNotThrow(() => validateNotificationText("🙂".repeat(4096)));
});

test("hosted limiter enforces per-target pacing and a 30-per-minute client cap", async () => {
  let time = 0;
  const limiter = new RateLimiter(
    () => time,
    async (milliseconds) => {
      time += milliseconds;
    },
  );
  await limiter.wait("client", "one-target");
  await limiter.wait("client", "one-target");
  assert.equal(time, 1000);

  time = 120_000;
  for (let index = 0; index < 30; index += 1) {
    await limiter.wait("another-client", `target-${index}`);
  }
  await assert.rejects(
    limiter.wait("another-client", "target-31"),
    RateLimitError,
  );
});

test("hosted HTTP exposes health checks but rejects unauthenticated MCP requests", async () => {
  const generated = createClientKey();
  const app = createHttpApp({
    targets,
    clients: {
      "project-one": {
        target: "ops-alerts",
        keySha256: generated.keySha256,
      },
    },
  }, {
    TELEGRAM_MCP_HOST: "127.0.0.1",
    TELEGRAM_MCP_ALLOWED_HOSTS: "localhost,127.0.0.1",
    TELEGRAM_MCP_PORT: "3000",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.deepEqual(await health.json(), { status: "ok" });

    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      fetch: (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${generated.key}`);
        return fetch(url, { ...init, headers });
      },
    });
    const client = new Client(
      { name: "hosted-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), ["send_notification"]);
      assert.equal("target" in tools.tools[0].inputSchema.properties, false);
    } finally {
      await client.close();
    }
  } finally {
    const handler = app.locals.telegramMcp.handler;
    await new Promise((resolve) => server.close(resolve));
    await handler.close();
  }
});

test("live HTTP keeps administrator discovery and project notification tools isolated", async () => {
  const adminKey = createClientKey();
  const projectKey = createClientKey();
  const config = {
    targets,
    clients: { project: { target: "dev-status", keySha256: projectKey.keySha256 } },
    discovery: {
      enabled: true,
      adminKeySha256: adminKey.keySha256,
      bots: { setup: { bot: "My_TG_Bot", token: BOT_TOKEN } },
    },
  };
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = mockTelegram(requests);
  let server;
  let project;
  let admin;
  try {
    server = await startTestHttpServer(config);
    project = await connectHttpClient(server.baseUrl, projectKey.key, realFetch);
    admin = await connectHttpClient(server.baseUrl, adminKey.key, realFetch);

    assert.deepEqual((await project.listTools()).tools.map((tool) => tool.name), ["send_notification"]);
    assert.deepEqual((await admin.listTools()).tools.map((tool) => tool.name), ["discover_chats"]);
    await assert.rejects(
      project.callTool({
        name: "discover_chats",
        arguments: { source: "bot", name: "setup", confirmNoOtherPoller: true },
      }),
      /Tool discover_chats not found/,
    );
    await assert.rejects(
      admin.callTool({ name: "send_notification", arguments: { text: "not allowed" } }),
      /Tool send_notification not found/,
    );
    assert.equal(requests.length, 0);

    const unknown = await admin.callTool({
      name: "discover_chats",
      arguments: { source: "target", name: "constructor", confirmNoOtherPoller: true },
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /Unknown discovery target/);
    assert.equal(requests.length, 0);

    const unconfirmed = await admin.callTool({
      name: "discover_chats",
      arguments: { source: "bot", name: "setup", confirmNoOtherPoller: false },
    });
    assert.equal(unconfirmed.isError, true);
    assert.equal(requests.length, 0);

    const sent = await project.callTool({
      name: "send_notification",
      arguments: { text: "Live status", target: "ops-alerts", chatId: targets["ops-alerts"].chatId },
    });
    assert.equal(sent.structuredContent.delivered, true);
    assert.equal(sent.structuredContent.target, "dev-status");
    assert.equal(requests[0].method, "sendMessage");
    assert.equal(requests[0].payload.chat_id, targets["dev-status"].chatId);
    assert.equal(requests[0].payload.text, "[project] Live status");

    for (const [source, name] of [["bot", "setup"], ["target", "dev-status"]]) {
      const result = await admin.callTool({
        name: "discover_chats",
        arguments: { source, name, confirmNoOtherPoller: true },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.chats, [
        { chatId: -998877, type: "group", title: "Setup chat" },
      ]);
      assert.equal(JSON.stringify(result).includes("private content"), false);
      assert.equal(JSON.stringify(result).includes(BOT_TOKEN), false);
      assert.equal(JSON.stringify(result).includes(adminKey.key), false);
    }
    assert.deepEqual(requests.map((request) => request.method), [
      "sendMessage",
      "getMe", "getWebhookInfo", "getUpdates",
      "getMe", "getWebhookInfo", "getUpdates",
    ]);
    assert.deepEqual(requests.filter((request) => request.method === "getUpdates")[0].payload, {
      limit: 100,
      timeout: 0,
    });
    const sentAfterDiscovery = await project.callTool({
      name: "send_notification",
      arguments: { text: "Still live" },
    });
    assert.equal(sentAfterDiscovery.structuredContent.target, "dev-status");
    assert.equal(requests.at(-1).payload.chat_id, targets["dev-status"].chatId);
  } finally {
    await project?.close();
    await admin?.close();
    await server?.close();
    globalThis.fetch = realFetch;
  }
});

test("hosted discovery bootstraps with no targets or clients using the environment override", async () => {
  const adminKey = createClientKey();
  const env = { BOT_TOKEN, TELEGRAM_MCP_DISCOVERY_ENABLED: "true" };
  const config = parseConfig(JSON.stringify({
    targets: {},
    discovery: {
      enabled: false,
      adminKeySha256: adminKey.keySha256,
      bots: { setup: { bot: "My_TG_Bot", token: "${BOT_TOKEN}" } },
    },
  }), env);
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = mockTelegram(requests);
  let server;
  let admin;
  try {
    server = await startTestHttpServer(config, env);
    admin = await connectHttpClient(server.baseUrl, adminKey.key, realFetch);
    assert.deepEqual((await admin.listTools()).tools.map((tool) => tool.name), ["discover_chats"]);
    const result = await admin.callTool({
      name: "discover_chats",
      arguments: { source: "bot", name: "setup", confirmNoOtherPoller: true },
    });
    assert.equal(result.structuredContent.chats[0].chatId, -998877);
    assert.equal(requests.length, 3);
  } finally {
    await admin?.close();
    await server?.close();
    globalThis.fetch = realFetch;
  }
});

test("environment override can disable discovery while leaving project access intact", async () => {
  const adminKey = createClientKey();
  const projectKey = createClientKey();
  const config = {
    targets,
    clients: { project: { target: "dev-status", keySha256: projectKey.keySha256 } },
    discovery: { enabled: true, adminKeySha256: adminKey.keySha256 },
  };
  const server = await startTestHttpServer(config, { TELEGRAM_MCP_DISCOVERY_ENABLED: "false" });
  let project;
  try {
    const rejected = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey.key}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(rejected.status, 401);
    project = await connectHttpClient(server.baseUrl, projectKey.key);
    assert.deepEqual((await project.listTools()).tools.map((tool) => tool.name), ["send_notification"]);
  } finally {
    await project?.close();
    await server.close();
  }
});

test("hosted discovery requires a separate administrator key even for empty setup", () => {
  const key = createClientKey();
  assert.throws(
    () => createHttpApp({ targets, discovery: { enabled: true } }, {}),
    /requires TELEGRAM_MCP_ADMIN_KEY or/,
  );
  assert.throws(
    () => createHttpApp({
      targets,
      clients: { project: { target: "dev-status", keySha256: key.keySha256 } },
      discovery: { enabled: true, adminKeySha256: key.keySha256 },
    }, {}),
    /must differ/,
  );
  assert.throws(
    () => createHttpApp({ targets }, { TELEGRAM_MCP_DISCOVERY_ENABLED: "yes" }),
    /must be "true" or "false"/,
  );
});

test("a platform-generated TELEGRAM_MCP_ADMIN_KEY overrides the stored administrator hash", async () => {
  const coolifyKey = "a1B2c3D4".repeat(8);
  const storedKey = createClientKey();
  const config = {
    targets,
    discovery: { enabled: true, adminKeySha256: storedKey.keySha256 },
  };
  const server = await startTestHttpServer(config, { TELEGRAM_MCP_ADMIN_KEY: coolifyKey });
  let admin;
  try {
    admin = await connectHttpClient(server.baseUrl, coolifyKey);
    assert.deepEqual((await admin.listTools()).tools.map((tool) => tool.name), ["discover_chats"]);
    const replaced = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${storedKey.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(replaced.status, 401);
  } finally {
    await admin?.close();
    await server.close();
  }

  assert.doesNotThrow(() => createHttpApp(
    { targets, discovery: { enabled: true } },
    { TELEGRAM_MCP_ADMIN_KEY: coolifyKey },
  ));
  assert.throws(
    () => createHttpApp({ targets, discovery: { enabled: true } }, { TELEGRAM_MCP_ADMIN_KEY: "" }),
    /requires TELEGRAM_MCP_ADMIN_KEY or/,
  );
  for (const invalid of ["too-short", "has spaces ".repeat(4), "x".repeat(257)]) {
    assert.throws(
      () => createHttpApp({ targets, discovery: { enabled: true } }, { TELEGRAM_MCP_ADMIN_KEY: invalid }),
      /must be 32-256/,
    );
  }
});
