import { join } from "node:path";
import { realpathSync, existsSync, readFileSync } from "node:fs";
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
import { ModelCredentials, ApiKeySchema } from "../model-config.js";
import { DomainError } from "../domain.js";
import type { SpeechPort } from "../speech.js";
import { registerPetVoice } from "./voice.js";
import type WebSocket from "ws";
import type { TranscriptionPort } from "../transcription.js";

export async function createPetRuntime(
  config: AppConfig,
  projectRoot: string,
  bridgePort = 0,
  options: {
    modelFactory?: () => ModelPort;
    speech?: SpeechPort;
    transcription?: TranscriptionPort;
    openRealtime?: (key: string) => WebSocket;
  } = {},
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
    const credentials = new ModelCredentials(coal.config);
    const Preferences = z
      .object({
        voiceEnabled: z.boolean().default(true),
        autoSpeak: z.boolean().default(true),
      })
      .strict();
    const preferencesPath = join(config.dataDir, "pet-preferences.json");
    let preferences = Preferences.parse(
      existsSync(preferencesPath)
        ? JSON.parse(readFileSync(preferencesPath, "utf8"))
        : {},
    );
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
      realtimeSocket: true,
      staticAssets: petAssets(
        projectRoot,
        config.modelMode === "mock" ? "mock" : "live",
      ),
      sessionCookieName: "harness_pet_session",
      speech: options.speech,
      transcription: options.transcription,
    });
    await registerPetVoice(
      app,
      coal,
      credentials,
      () => preferences.voiceEnabled,
      options.openRealtime,
    );
    app.get("/v1/pet/setup", async () => ({
      ...credentials.petSetupStatus(),
      preferences,
    }));
    app.patch("/v1/pet/preferences", async (req) => {
      const patch = Preferences.partial().parse(req.body);
      preferences = Preferences.parse({ ...preferences, ...patch });
      writePrivateJson(preferencesPath, preferences);
      return preferences;
    });
    app.put("/v1/pet/setup", async (req) => {
      const input = z
        .object({
          deepseekKey: ApiKeySchema.optional(),
          fishAudioKey: ApiKeySchema.optional(),
        })
        .strict()
        .parse(req.body);
      for (const run of coal.store.byStatus("runs", ["queued", "running"]))
        coal.cancel(run.id);
      const status = credentials.savePetKeys(
        input.deepseekKey,
        input.fishAudioKey,
      );
      coal.updateSettings({
        expectedRevision: coal.store.settings().revision,
        model: "deepseek-flash",
        remoteDisclosureAcknowledged: true,
      });
      return { ...status, preferences };
    });
    app.addHook("preHandler", async (req) => {
      if (
        req.method === "POST" &&
        req.routeOptions.url === "/v1/threads/:id/inputs" &&
        !credentials.petSetupStatus().ready
      )
        throw new DomainError("pet_setup_required", 409);
    });
    app.get("/v1/pet/codex", async () => ({
      ...state.snapshot(),
      controls: controls.filter((c) => Date.now() - c.issuedAt < 30_000),
      setup: credentials.petSetupStatus(),
      preferences,
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
