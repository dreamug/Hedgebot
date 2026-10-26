import { join } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { BotManager, ORIGINAL_BOT_ID } from "../bots.js";
import type { AppConfig } from "../config.js";
import { createApp } from "../server.js";
import { acquireInstance } from "../instance.js";
import { writePrivateJson } from "../files.js";
import { createCodexBridge } from "./codex-bridge.js";
import { COAL_BOT_ID, COAL_PERSONA } from "./persona.js";
import { petAssets } from "./assets.js";
import type { ModelPort } from "../model.js";
import { PetMockModel } from "./mock-model.js";

export async function createPetRuntime(
  config: AppConfig,
  projectRoot: string,
  bridgePort = 0,
  options: { modelFactory?: () => ModelPort } = {},
) {
  const release = acquireInstance(config.dataDir);
  let bots: BotManager | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let bridge: Awaited<ReturnType<typeof createCodexBridge>> | undefined;
  try {
    bots = new BotManager(
      config,
      options.modelFactory ??
        (config.modelMode === "mock" ? () => new PetMockModel(15) : undefined),
    );
    if (!bots.list().some((b) => b.id === COAL_BOT_ID))
      bots.create(
        { name: "煤球", persona: COAL_PERSONA, template: "companion" },
        COAL_BOT_ID,
      );
    const coal = bots.get(COAL_BOT_ID);
    bridge = await createCodexBridge(projectRoot, bridgePort);
    const state = bridge.state;
    const ControlSchema = z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("action"),
          id: z.enum(["fruit", "heart", "sign", "cake", "wave"]),
          nonce: z.string().uuid(),
        })
        .strict(),
      z
        .object({
          type: z.literal("size"),
          value: z.union([
            z.literal(64),
            z.literal(96),
            z.literal(128),
            z.literal(192),
          ]),
          nonce: z.string().uuid(),
        })
        .strict(),
    ]);
    const controls: (z.infer<typeof ControlSchema> & { issuedAt: number })[] =
      [];
    app = await createApp(bots.get(ORIGINAL_BOT_ID), {
      bots,
      staticAssets: petAssets(
        projectRoot,
        config.modelMode === "mock" ? "mock" : "live",
      ),
      sessionCookieName: "harness_pet_session",
    });
    app.get("/v1/pet/codex", async () => ({
      ...state.snapshot(),
      controls: controls.filter((c) => Date.now() - c.issuedAt < 30_000),
    }));
    app.post("/v1/pet/control", async (req) => {
      const input = ControlSchema.parse(req.body);
      if (!controls.some((c) => c.nonce === input.nonce))
        controls.push({ ...input, issuedAt: Date.now() });
      if (controls.length > 32) controls.splice(0, controls.length - 32);
      return { accepted: true };
    });
    app.post("/v1/pet/codex/bind", async (req, reply) => {
      const { sessionId } = z
        .object({ sessionId: z.string().min(1).max(200).nullable() })
        .strict()
        .parse(req.body);
      if (!state.bind(sessionId))
        return reply.code(404).send({ error: "codex_session_not_found" });
      return state.snapshot();
    });
    const address = await app.listen({ host: config.host, port: config.port });
    writePrivateJson(join(config.dataDir, "codex-bridge.json"), {
      schemaVersion: 1,
      address: `${bridge.address}/events`,
      token: bridge.token,
      projectRoot: realpathSync(projectRoot),
      pid: process.pid,
    });
    writePrivateJson(join(config.dataDir, "daemon.lock"), {
      pid: process.pid,
      startedAt: Date.now(),
      address,
      kind: "hedgehog-desktop-v1",
    });
    bots.start();
    let closed = false;
    return {
      app,
      bots,
      coal,
      bridge,
      address,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await app!.close();
        } finally {
          await bridge!.app.close();
          await bots!.close();
          release();
        }
      },
    };
  } catch (error) {
    await app?.close();
    await bridge?.app.close();
    await bots?.close();
    release();
    throw error;
  }
}
