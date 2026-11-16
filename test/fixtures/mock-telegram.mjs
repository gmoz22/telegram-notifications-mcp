globalThis.fetch = async (url, init) => {
  const address = new URL(url);
  if (address.hostname !== "api.telegram.org") throw new Error("Unexpected network request in CLI test.");
  const method = address.pathname.split("/").at(-1);
  const payload = JSON.parse(init.body);
  const chat = { id: -1001234567890, type: "supergroup", title: "Setup chat" };
  switch (method) {
    case "getMe":
      return Response.json({ ok: true, result: { is_bot: true, username: "valid_bot" } });
    case "getWebhookInfo":
      return Response.json({ ok: true, result: { url: "" } });
    case "getUpdates":
      if (JSON.stringify(payload) !== JSON.stringify({ limit: 100, timeout: 0 })) {
        throw new Error("Discovery changed polling parameters.");
      }
      return Response.json({
        ok: true,
        result: [{ update_id: 1, message: { chat, message_thread_id: 42, text: "private content" } }],
      });
    case "getChat":
      return Response.json({ ok: true, result: chat });
    case "sendMessage":
      return Response.json({ ok: true, result: { message_id: 23, chat: { id: payload.chat_id } } });
    default:
      throw new Error("Unexpected Telegram method in CLI test.");
  }
};
