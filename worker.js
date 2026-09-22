const CHANNEL = "SeekrTrending";
const MAX_MC = 3_000_000;
const MIN_LIQ = 10_000;
const MIN_SCORE = 7;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      return Response.json(await scan(env));
    }

    return Response.json({
      status: "Seekr tracker online",
      interval: "3 minutes",
      hours: "5:00 a.m.–8:00 p.m. Pacific",
      configured: Boolean(
        env.TELEGRAM_BOT_TOKEN &&
        env.TELEGRAM_CHAT_ID &&
        env.STATE
      ),
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scan(env));
  },
};

export class State {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/get") {
      const value =
        (await this.storage.get("last_message_id")) || 0;

      return new Response(String(value));
    }

    if (
      url.pathname === "/put" &&
      request.method === "POST"
    ) {
      await this.storage.put(
        "last_message_id",
        await request.text()
      );

      return new Response("ok");
    }

    return new Response("not found", { status:
