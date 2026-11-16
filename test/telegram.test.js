import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverTelegramChats,
  sendTelegramMessage,
  TelegramError,
  verifyTelegramTarget,
} from "../dist/telegram.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const target = {
  bot: "My_TG_Bot",
  token: TOKEN,
  chatId: -1001234567890,
  threadId: 42,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("verifies the configured bot, supported chat and forum topic", async () => {
  const responses = [
    jsonResponse({ ok: true, result: { is_bot: true, username: "My_TG_Bot" } }),
    jsonResponse({ ok: true, result: { id: target.chatId, type: "supergroup", is_forum: true } }),
  ];
  await verifyTelegramTarget("dev-status", target, async () => responses.shift());
});

test("sends HTML, silent mode and topic ID then verifies the delivery receipt", async () => {
  let requestUrl;
  let requestPayload;
  const messageId = await sendTelegramMessage({
    targetName: "dev-status",
    target,
    text: "<b>Ready</b>",
    format: "html",
    silent: true,
    fetchImpl: async (url, init) => {
      requestUrl = url;
      requestPayload = JSON.parse(init.body);
      return jsonResponse({
        ok: true,
        result: { message_id: 17, chat: { id: target.chatId } },
      });
    },
  });

  assert.equal(messageId, 17);
  assert.match(requestUrl, new RegExp(TOKEN));
  assert.equal(requestPayload.parse_mode, "HTML");
  assert.equal(requestPayload.disable_notification, true);
  assert.equal(requestPayload.message_thread_id, 42);
});

test("rejects unconfirmed, wrong-recipient and failed responses without leaking the token", async () => {
  await assert.rejects(
    sendTelegramMessage({
      targetName: "dev-status",
      target,
      text: "hello",
      format: "plain",
      silent: false,
      fetchImpl: async () => jsonResponse({
        ok: true,
        result: { message_id: 17, chat: { id: 123 } },
      }),
    }),
    /did not confirm delivery/,
  );

  await assert.rejects(
    sendTelegramMessage({
      targetName: "dev-status",
      target,
      text: "hello",
      format: "plain",
      silent: false,
      fetchImpl: async () => {
        throw new TypeError(`fetch failed for ${TOKEN}`);
      },
    }),
    (error) => {
      assert.ok(error instanceof TelegramError);
      assert.match(error.message, /not retried/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});

test("discovers only chat metadata without confirming or filtering pending updates", async () => {
  const requests = [];
  const updates = [
    {
      update_id: 1,
      message: {
        chat: { id: 123, type: "private", first_name: "Alice", username: "alice_1" },
        text: "private message that must not be returned",
      },
    },
    {
      update_id: 2,
      message: { chat: { id: -42, type: "group", title: "Engineering" }, text: TOKEN },
    },
    {
      update_id: 3,
      message: { chat: { id: -1001, type: "supergroup", title: "Forum" }, message_thread_id: 7 },
    },
    {
      update_id: 4,
      edited_message: { chat: { id: -1001, type: "supergroup", title: "Forum" }, message_thread_id: 8 },
    },
    {
      update_id: 5,
      channel_post: { chat: { id: -1002, type: "channel", title: "Releases" }, text: "channel secret" },
    },
    {
      update_id: 6,
      my_chat_member: { chat: { id: -1003, type: "group", title: `Do not leak ${TOKEN}` } },
    },
    {
      update_id: 7,
      inline_query: { query: "private query that must not be returned" },
    },
    {
      update_id: 8,
      callback_query: { message: { chat: { id: -42, type: "group" }, text: "callback secret" } },
    },
  ];
  const result = await discoverTelegramChats({
    botName: "setup",
    bot: target,
    confirmNoOtherPoller: true,
    fetchImpl: async (url, init) => {
      const method = new URL(url).pathname.split("/").at(-1);
      requests.push({ method, payload: JSON.parse(init.body) });
      if (method === "getMe") {
        return jsonResponse({ ok: true, result: { is_bot: true, username: target.bot } });
      }
      if (method === "getWebhookInfo") {
        return jsonResponse({ ok: true, result: { url: "" } });
      }
      assert.equal(method, "getUpdates");
      return jsonResponse({ ok: true, result: updates });
    },
  });

  assert.deepEqual(requests, [
    { method: "getMe", payload: {} },
    { method: "getWebhookInfo", payload: {} },
    { method: "getUpdates", payload: { limit: 100, timeout: 0 } },
  ]);
  assert.deepEqual(result, {
    bot: target.bot,
    chats: [
      { chatId: 123, type: "private", firstName: "Alice", username: "alice_1" },
      { chatId: -42, type: "group", title: "Engineering" },
      { chatId: -1001, type: "supergroup", title: "Forum", threadIds: [7, 8] },
      { chatId: -1002, type: "channel", title: "Releases" },
      { chatId: -1003, type: "group", title: "[redacted]" },
    ],
    updatesScanned: 8,
    mayHaveMore: false,
  });
  const output = JSON.stringify(result);
  assert.equal(output.includes(TOKEN), false);
  assert.equal(output.includes("private message"), false);
  assert.equal(output.includes("private query"), false);
  assert.equal(output.includes("channel secret"), false);
  assert.equal(output.includes("callback secret"), false);
});

test("requires explicit poller confirmation before making any Telegram request", async () => {
  let calls = 0;
  for (const confirmation of [false, undefined, "true"]) {
    await assert.rejects(
      discoverTelegramChats({
        botName: "setup",
        bot: target,
        confirmNoOtherPoller: confirmation,
        fetchImpl: async () => {
          calls += 1;
          throw new Error("must not be called");
        },
      }),
      /Confirm that no other process polls/,
    );
  }
  assert.equal(calls, 0);
});

test("refuses webhook conflicts without exposing the webhook URL or fetching updates", async () => {
  const methods = [];
  const webhookUrl = `https://example.test/secret/${TOKEN}`;
  await assert.rejects(
    discoverTelegramChats({
      botName: "setup",
      bot: target,
      confirmNoOtherPoller: true,
      fetchImpl: async (url) => {
        const method = new URL(url).pathname.split("/").at(-1);
        methods.push(method);
        if (method === "getMe") {
          return jsonResponse({ ok: true, result: { is_bot: true, username: target.bot } });
        }
        return jsonResponse({ ok: true, result: { url: webhookUrl } });
      },
    }),
    (error) => {
      assert.ok(error instanceof TelegramError);
      assert.match(error.message, /has a webhook/);
      assert.equal(error.message.includes(webhookUrl), false);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.deepEqual(methods, ["getMe", "getWebhookInfo"]);
});

test("discovery rejects mismatched bots and sanitizes network and malformed response errors", async () => {
  const options = { botName: "setup", bot: target, confirmNoOtherPoller: true };
  let calls = 0;
  await assert.rejects(
    discoverTelegramChats({
      ...options,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ ok: true, result: { is_bot: true, username: "different_bot" } });
      },
    }),
    /does not match the configured bot username/,
  );
  assert.equal(calls, 1);

  await assert.rejects(
    discoverTelegramChats({
      ...options,
      fetchImpl: async () => {
        throw new TypeError(`network error containing ${TOKEN}`);
      },
    }),
    (error) => {
      assert.match(error.message, /getMe request failed or timed out/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );

  await assert.rejects(
    discoverTelegramChats({
      ...options,
      fetchImpl: async () => new Response(`invalid response ${TOKEN}`),
    }),
    (error) => {
      assert.match(error.message, /invalid getMe response/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});

test("reports a full update batch and rejects invalid or conflicting responses safely", async () => {
  const fetchWithUpdates = (updatesResponse) => async (url) => {
    const method = new URL(url).pathname.split("/").at(-1);
    if (method === "getMe") {
      return jsonResponse({ ok: true, result: { is_bot: true, username: target.bot } });
    }
    if (method === "getWebhookInfo") {
      return jsonResponse({ ok: true, result: { url: "" } });
    }
    return updatesResponse;
  };
  const options = { botName: "setup", bot: target, confirmNoOtherPoller: true };
  const updates = Array.from({ length: 100 }, (_, index) => ({
    update_id: index + 1,
    inline_query: { query: "ignored" },
  }));
  const result = await discoverTelegramChats({
    ...options,
    fetchImpl: fetchWithUpdates(jsonResponse({ ok: true, result: updates })),
  });
  assert.deepEqual(result.chats, []);
  assert.equal(result.updatesScanned, 100);
  assert.equal(result.mayHaveMore, true);

  for (const invalidResult of [{}, [...updates, { update_id: 101 }], [{ update_id: 1, message: {} }]]) {
    await assert.rejects(
      discoverTelegramChats({
        ...options,
        fetchImpl: fetchWithUpdates(jsonResponse({ ok: true, result: invalidResult })),
      }),
      /invalid/,
    );
  }

  await assert.rejects(
    discoverTelegramChats({
      ...options,
      fetchImpl: fetchWithUpdates(jsonResponse({
        ok: false,
        error_code: 409,
        description: `Conflict with ${TOKEN}`,
      }, 409)),
    }),
    (error) => {
      assert.match(error.message, /another update consumer may be active/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});
