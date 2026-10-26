import Fastify from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CodexPetState } from "./codex-state.js";

export async function createCodexBridge(projectRoot: string, port = 0) {
  const token = randomBytes(32).toString("hex");
  const state = new CodexPetState(projectRoot);
  const app = Fastify({ logger: false, bodyLimit: 8192, requestTimeout: 1500 });
  app.addHook("onRequest", async (req, reply) => {
    const auth = req.headers.authorization;
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(typeof auth === "string" ? auth : "");
    if (
      req.headers.origin ||
      !/^(?:127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "") ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return reply.code(403).send({ error: "bridge_denied" });
  });
  app.setErrorHandler((_error, _req, reply) =>
    reply.code(400).send({ error: "invalid_event" }),
  );
  app.post("/events", async (req) => state.ingest(req.body));
  const address = await app.listen({ host: "127.0.0.1", port });
  return { app, state, address, token };
}
