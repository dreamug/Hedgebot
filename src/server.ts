import websocket from "@fastify/websocket";
import { evidenceValid, resolveEvidence } from "./memory/evidence.js";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { BotManager, ORIGINAL_BOT_ID, CreateBotSchema } from "./bots.js";
import { Readable } from "node:stream";
import cookie from "@fastify/cookie";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { Harness } from "./harness.js";
import { DomainError, THREAD_ID } from "./domain.js";
import {
  ApiKeySchema,
  ProviderSchema,
  ModelCredentials,
} from "./model-config.js";
import { abortable } from "./async.js";
import {
  FishAudioSpeech,
  FISH_VOICE_ID,
  FISH_VOICE_NAME,
  VOICE_PREVIEW,
  MAX_SPEECH_CHARS,
  type SpeechPort,
} from "./speech.js";

import {
  COMPARISON_TEXT,
  SPEECH_COMPARISONS,
  ComparisonId,
  comparison,
  comparisonOptions,
} from "./speech-comparison.js";

import { preparedSpeechSamples } from "./speech-samples.js";
import {
  LocalTranscription,
  localAsrConfigured,
} from "./local-transcription.js";
import {
  FishAudioTranscription,
  RecordingSchema,
  ASR_MODEL,
  MAX_RECORDING_SECONDS,
  MAX_RECORDING_BYTES,
  decodeRecording,
  type TranscriptionPort,
} from "./transcription.js";

function equal(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function createApp(
  harness: Harness,
  options: {
    realtimeSocket?: boolean;
    speech?: SpeechPort;
    bots?: BotManager;
    transcription?: TranscriptionPort;
    /** Public, explicitly enumerated assets for the optional desktop client. */
    staticAssets?: ReadonlyMap<string, { type: string; body: Buffer }>;
    /** Cookies are host-scoped, not port-scoped: desktop must not replace the Web session. */
    sessionCookieName?: string;
  } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 10000,
  });
  await app.register(cookie);
  if (options.realtimeSocket)
    await app.register(websocket, { options: { maxPayload: 32768 } });
  const selectedRequests = new WeakMap<FastifyRequest, Harness>();
  const requestedBot = (req: FastifyRequest): string => {
    const header = req.headers["x-bot-id"];
    const query = new URL(req.url, "http://localhost").searchParams.get(
      "botId",
    );
    if (
      (header !== undefined && typeof header !== "string") ||
      (header && query && header !== query)
    )
      throw new DomainError("bot_selector_invalid", 400);
    return typeof header === "string" ? header : (query ?? ORIGINAL_BOT_ID);
  };
  const selected = (req: FastifyRequest): Harness => {
    const cached = selectedRequests.get(req);
    if (cached) return cached;
    const id = requestedBot(req);
    const target = options.bots
      ? options.bots.get(id)
      : id === ORIGINAL_BOT_ID
        ? harness
        : undefined;
    if (!target) throw new DomainError("bot_not_found", 404);
    selectedRequests.set(req, target);
    return target;
  };
  const fishConfig = (target: Harness) => ({
    ...target.config,
    fishAudioApiKey: new ModelCredentials(target.config).fishAudioKey(),
  });
  const speechFor = (target: Harness) =>
    options.speech ?? new FishAudioSpeech(fishConfig(target));
  const transcriptionFor = (target: Harness) =>
    options.transcription ??
    (target.config.transcriptionMode === "local"
      ? new LocalTranscription(target.config)
      : new FishAudioTranscription(fishConfig(target)));
  const speechRequests = new Set<AbortController>();
  const transcriptionRequests = new Map<Harness, AbortController>();
  app.addHook("preClose", async () => {
    for (const request of speechRequests) request.abort("shutdown");
    for (const request of transcriptionRequests.values())
      request.abort("shutdown");
  });
  const sessionCookie =
    options.sessionCookieName ??
    (harness.config.memoryV3 ? "harness_session_cm3" : "harness_session");
  const session = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex");
  const assets = new Map<string, { type: string; body: Buffer }>([
    [
      "/",
      {
        type: "text/html; charset=utf-8",
        body: readFileSync(new URL("../web/index.html", import.meta.url)),
      },
    ],
    [
      "/app.js",
      {
        type: "text/javascript; charset=utf-8",
        body: readFileSync(new URL("../web/app.js", import.meta.url)),
      },
    ],
    [
      "/style.css",
      {
        type: "text/css; charset=utf-8",
        body: readFileSync(new URL("../web/style.css", import.meta.url)),
      },
    ],
    [
      "/voice-input.js",
      {
        type: "text/javascript; charset=utf-8",
        body: readFileSync(new URL("../web/voice-input.js", import.meta.url)),
      },
    ],
  ]);
  for (const [path, file, type] of [
    ["/voice-lab", "voice-lab.html", "text/html; charset=utf-8"],
    ["/voice-lab.js", "voice-lab.js", "text/javascript; charset=utf-8"],
    ["/voice-lab.css", "voice-lab.css", "text/css; charset=utf-8"],
    ["/run-status.js", "run-status.js", "text/javascript; charset=utf-8"],
  ])
    assets.set(path!, {
      type: type!,
      body: readFileSync(new URL(`../web/${file}`, import.meta.url)),
    });
  for (const [path, asset] of options.staticAssets ?? [])
    assets.set(path, asset);
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host ?? "";
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host))
      throw new DomainError("invalid_host", 403);
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`)
      throw new DomainError("invalid_origin", 403);
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw new DomainError("cross_site_denied", 403);
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const path = req.url.split("?")[0]!;
    if (assets.has(path) || path === "/bootstrap") return;
    if (!equal(req.cookies[sessionCookie], session))
      throw new DomainError("unauthorized", 401);
    if (
      !["GET", "HEAD"].includes(req.method) &&
      !equal(req.headers["x-local-token"], csrf)
    )
      throw new DomainError("csrf_required", 403);
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: "validation_failed",
        fields: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message.slice(0, 100),
        })),
      });
    if (error instanceof DomainError)
      return reply.code(error.status).send({ error: error.code });
    // Provider/library errors may contain request headers. Never serialize or log the raw object.
    return reply
      .code((error as { statusCode?: number }).statusCode === 413 ? 413 : 500)
      .send({
        error:
          (error as { statusCode?: number }).statusCode === 413
            ? "body_too_large"
            : "internal_error",
      });
  });
  for (const [path, asset] of assets)
    app.get(path, async (_req, reply) =>
      reply.type(asset.type).send(asset.body),
    );
  app.get("/bootstrap", async (req, reply) => {
    reply.setCookie(sessionCookie, session, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 86400,
    });
    return {
      csrfToken: csrf,
      relationshipId: selected(req).store.scope.relationshipId,
      threadId: THREAD_ID,
      botId: requestedBot(req),
      bots: options.bots?.list() ?? [
        {
          id: ORIGINAL_BOT_ID,
          name: selected(req).store.settings().persona.name,
          original: true,
          status: "active",
          mode: "companion",
        },
      ],
    };
  });
  const relationship = (req: FastifyRequest, id: unknown) => {
    if (id !== selected(req).store.scope.relationshipId)
      throw new DomainError("not_found", 404);
  };
  app.get(
    "/v1/bots",
    async () =>
      options.bots?.list() ?? [
        {
          id: ORIGINAL_BOT_ID,
          name: harness.store.settings().persona.name,
          original: true,
          status: "active",
          mode: "companion",
        },
      ],
  );
  app.post("/v1/bots", async (req) => {
    if (!options.bots) throw new DomainError("bots_unavailable", 409);
    return options.bots.create(CreateBotSchema.parse(req.body));
  });
  app.post("/v1/bots/:id/archive", async (req) => {
    if (!options.bots) throw new DomainError("bots_unavailable", 409);
    return options.bots.archive(
      z.object({ id: z.string() }).parse(req.params).id,
    );
  });
  app.post("/v1/bots/:id/restore", async (req) => {
    if (!options.bots) throw new DomainError("bots_unavailable", 409);
    return options.bots.restore(
      z.object({ id: z.string() }).parse(req.params).id,
    );
  });
  const idParam = (req: { params: unknown }) =>
    z.object({ id: z.string().min(1).max(150) }).parse(req.params).id;
  app.get("/v1/voice", async (req) => ({
    provider: "fish-audio",
    configured: Boolean(
      options.speech || fishConfig(selected(req)).fishAudioApiKey,
    ),
    voiceId: selected(req).config.fishAudioVoiceId ?? FISH_VOICE_ID,
    voiceName: FISH_VOICE_NAME,
    transport: "http-streaming",
    model: selected(req).config.fishAudioModel ?? "s2.1-pro",
    maxChars: MAX_SPEECH_CHARS,
  }));
  app.get("/v1/voice-input", async (req) => {
    const h = selected(req),
      remote = transcriptionFor(h).remote !== false;
    return {
      provider: remote ? "fish-audio" : "local-whisper",
      model: remote ? ASR_MODEL : "whisper-local",
      remote,
      configured: Boolean(
        options.transcription ||
        (remote ? fishConfig(h).fishAudioApiKey : localAsrConfigured(h.config)),
      ),
      maxSeconds: MAX_RECORDING_SECONDS,
      maxBytes: MAX_RECORDING_BYTES,
    };
  });
  app.post(
    "/v1/transcriptions",
    { bodyLimit: 6 * 1024 * 1024 },
    async (req, reply) => {
      const h = selected(req);
      const input = RecordingSchema.parse(req.body);
      const transcriber = transcriptionFor(h);
      const valid = () => {
        const s = h.store.settings();
        if (s.epoch !== input.expectedEpoch)
          throw new DomainError("transcription_invalidated", 409);
        if (transcriber.remote !== false && !s.remoteDisclosureAcknowledged)
          throw new DomainError("remote_disclosure_required", 409);
      };
      valid();
      if (transcriptionRequests.has(h) || transcriptionRequests.size >= 2)
        throw new DomainError("transcription_busy", 429);
      const audio = decodeRecording(input.audio, input.mimeType);
      const controller = new AbortController();
      transcriptionRequests.set(h, controller);
      const timer = setTimeout(() => controller.abort("timeout"), 45000);
      timer.unref();
      const invalidate = () => {
        try {
          valid();
        } catch {
          controller.abort("invalidated");
        }
      };
      const shutdown = () => controller.abort("shutdown");
      const disconnect = () => {
        if (!reply.raw.writableEnded) controller.abort("disconnected");
      };
      h.signals.on("change", invalidate);
      h.signals.on("shutdown", shutdown);
      reply.raw.on("close", disconnect);
      try {
        const result = await abortable(
          transcriber.transcribe(audio, input.mimeType, controller.signal),
          controller.signal,
        );
        if (controller.signal.aborted)
          throw new DomainError("transcription_cancelled", 409);
        valid();
        return {
          text: result.text,
          duration: result.duration,
          botId: requestedBot(req),
          epoch: input.expectedEpoch,
        };
      } catch (error) {
        if (controller.signal.aborted)
          throw new DomainError(
            controller.signal.reason === "timeout"
              ? "transcription_timeout"
              : "transcription_cancelled",
            controller.signal.reason === "timeout" ? 504 : 409,
          );
        throw error;
      } finally {
        clearTimeout(timer);
        transcriptionRequests.delete(h);
        h.signals.off("change", invalidate);
        h.signals.off("shutdown", shutdown);
        reply.raw.off("close", disconnect);
        controller.abort("finished");
      }
    },
  );
  app.get("/v1/voice-comparison", async (req) => ({
    configured: Boolean(
      options.speech || fishConfig(selected(req)).fishAudioApiKey,
    ),
    expectedEpoch: selected(req).store.settings().epoch,
    text: COMPARISON_TEXT,
    voiceId: FISH_VOICE_ID,
    voiceName: FISH_VOICE_NAME,
    author: "shi9444woyi334390",
    transport: "http-streaming",
    parameters: {
      latency: "balanced",
      chunk_length: 100,
      temperature: 0.7,
      top_p: 0.7,
      prosody: { speed: 1, volume: 0 },
      format: "mp3",
      mp3_bitrate: 128,
      normalize: true,
    },
    variants: SPEECH_COMPARISONS,
    preparedSamples: preparedSpeechSamples(harness.config.dataDir).map(
      ({ audio: _audio, ...sample }) => sample,
    ),
  }));
  app.get("/v1/voice-comparison/samples/:id", async (req, reply) => {
    const id = ComparisonId.parse(idParam(req));
    const sample = preparedSpeechSamples(harness.config.dataDir).find(
      (s) => s.id === id,
    );
    if (!sample) throw new DomainError("not_found", 404);
    return reply.type("audio/mpeg").send(sample.audio);
  });
  const speechHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const isComparison =
      req.url.split("?")[0] === "/v1/voice-comparison/speech";
    const variant = isComparison
      ? comparison(
          z
            .object({
              variantId: ComparisonId,
              expectedEpoch: z.number().int().positive(),
            })
            .strict()
            .parse(req.body).variantId,
        )
      : undefined;
    const speechOptions = variant ? comparisonOptions(variant.id) : undefined;
    const input = variant
      ? {
          kind: "comparison" as const,
          expectedEpoch: (req.body as { expectedEpoch: number }).expectedEpoch,
          id: undefined,
          expectedRevision: undefined,
        }
      : z
          .object({
            kind: z.enum(["message", "delivery", "preview"]),
            id: z.string().min(1).max(150).optional(),
            expectedEpoch: z.number().int().positive(),
            expectedRevision: z.number().int().positive().optional(),
          })
          .strict()
          .parse(req.body);
    const target = (checkRevision = true) => {
      const settings = selected(req).store.settings();
      if (input.expectedEpoch !== settings.epoch)
        throw new DomainError("speech_source_invalidated", 409);
      if (variant) return variant.cue + COMPARISON_TEXT;
      if (input.kind === "preview") return VOICE_PREVIEW;
      if (!input.id || !input.expectedRevision)
        throw new DomainError("speech_target_required");
      if (input.kind === "message") {
        const message = selected(req).store.require("messages", input.id);
        if (
          message.deleted ||
          message.role !== "assistant" ||
          message.status !== "completed" ||
          (checkRevision && message.revision !== input.expectedRevision) ||
          !message.content.trim()
        )
          throw new DomainError("speech_source_invalidated", 409);
        return message.content;
      }
      const delivery = selected(req).store.require("deliveries", input.id);
      if (
        ["cancelled", "expired"].includes(delivery.status) ||
        (checkRevision && delivery.revision !== input.expectedRevision) ||
        !delivery.text.trim() ||
        !selected(req).store.sourcesValid(delivery.sources)
      )
        throw new DomainError("speech_source_invalidated", 409);
      return delivery.text;
    };
    const text = target();
    if (text.length > MAX_SPEECH_CHARS)
      throw new DomainError("speech_text_too_long");
    // Only one synthesis at a time. No automatic retry of chargeable external synthesis.
    if (speechRequests.size) throw new DomainError("speech_busy", 429);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort("timeout"), 45000);
    deadline.unref();
    speechRequests.add(controller);
    const invalidate = () => {
      try {
        if (target(false) !== text) controller.abort("source_changed");
      } catch {
        controller.abort("source_changed");
      }
    };
    const disconnected = () => {
      if (!reply.raw.writableEnded) controller.abort("disconnected");
    };
    selected(req).signals.on("change", invalidate);
    const shutdownSpeech = () => controller.abort("shutdown");
    selected(req).signals.on("shutdown", shutdownSpeech);
    reply.raw.on("close", disconnected);
    const started = Date.now();
    let firstChunkMs: number | null = null,
      bytes = 0,
      chunks = 0,
      cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(deadline);
      speechRequests.delete(controller);
      selected(req).signals.off("change", invalidate);
      selected(req).signals.off("shutdown", shutdownSpeech);
      reply.raw.off("close", disconnected);
    };
    const check = () => {
      if (controller.signal.aborted)
        throw new DomainError(
          controller.signal.reason === "timeout"
            ? "speech_timeout"
            : "speech_cancelled",
          controller.signal.reason === "timeout" ? 504 : 409,
        );
      if (target(false) !== text)
        throw new DomainError("speech_source_invalidated", 409);
    };
    const iterator = speechFor(selected(req))
      .stream(text, controller.signal, speechOptions)
      [Symbol.asyncIterator]();
    const next = async () => {
      try {
        const result = await abortable(iterator.next(), controller.signal);
        check();
        return result;
      } catch (error) {
        check();
        throw error;
      }
    };
    const record = (status: string) => {
      // Archiving may already have closed this bot's store; cleanup must still run.
      if (controller.signal.reason === "shutdown") return;
      selected(req).store.trace(
        input.id ??
          (variant ? `voice-comparison-${variant.id}` : "voice-preview"),
        "speech",
        status,
        {
          provider: "fish-audio",
          model:
            speechOptions?.model ??
            selected(req).config.fishAudioModel ??
            "s2.1-pro",
          voiceId:
            speechOptions?.voiceId ??
            selected(req).config.fishAudioVoiceId ??
            FISH_VOICE_ID,
          ...(variant ? { comparisonId: variant.id } : {}),
          transport: "http-streaming",
          chars: text.length,
          bytes,
          chunks,
          firstChunkMs,
          elapsedMs: Date.now() - started,
          costCny: null,
          audioPersisted: false,
        },
        selected(req).clock.now(),
      );
    };
    try {
      // Reject pre-audio errors as JSON before committing any response headers.
      const first = await next();
      if (first.done || !first.value.byteLength)
        throw new DomainError("speech_empty_audio", 502);
      firstChunkMs = Date.now() - started;
      const audio = Readable.from(
        (async function* () {
          let completed = false;
          try {
            let part: IteratorResult<Uint8Array> = first;
            while (!part.done) {
              check();
              bytes += part.value.byteLength;
              chunks++;
              yield part.value;
              part = await next();
            }
            completed = true;
            record("synthesized");
          } finally {
            try {
              if (!completed) record("stream_interrupted");
            } finally {
              controller.abort("stream_closed");
              void iterator.return?.().catch(() => {});
              cleanup();
            }
          }
        })(),
      );
      audio.once("close", () => {
        controller.abort("stream_closed");
        void iterator.return?.().catch(() => {});
        cleanup();
      });
      // Native streams preserve backpressure. An error after headers truncates the
      // HTTP response instead of appending JSON to playable audio.
      return reply
        .header("X-Speech-First-Chunk-Ms", String(firstChunkMs))
        .header("X-Accel-Buffering", "no")
        .type("audio/mpeg")
        .send(audio);
    } catch (error) {
      controller.abort("request_failed");
      void iterator.return?.().catch(() => {});
      cleanup();
      throw error;
    }
  };
  app.post("/v1/speech", speechHandler);
  app.post("/v1/voice-comparison/speech", speechHandler);
  app.get("/v1/relationships/:id/snapshot", async (req) => {
    relationship(req, idParam(req));
    return selected(req).snapshot();
  });
  app.patch("/v1/relationships/:id/settings", async (req) => {
    relationship(req, idParam(req));
    return selected(req).updateSettings(req.body);
  });
  app.put("/v1/model-credentials/:provider", async (req) => {
    const provider = ProviderSchema.parse(
      (req.params as { provider: string }).provider,
    );
    const { apiKey } = z
      .object({ apiKey: ApiKeySchema })
      .strict()
      .parse(req.body);
    return selected(req).updateModelKey(provider, apiKey);
  });
  app.delete("/v1/model-credentials/:provider", async (req) => {
    const provider = ProviderSchema.parse(
      (req.params as { provider: string }).provider,
    );
    return selected(req).updateModelKey(provider);
  });
  app.post("/v1/threads/:id/inputs", async (req) => {
    if (idParam(req) !== THREAD_ID) throw new DomainError("not_found", 404);
    const p = z
      .object({ text: z.string(), idempotencyKey: z.string() })
      .strict()
      .parse(req.body);
    return selected(req).submit(p.text, p.idempotencyKey);
  });
  app.get("/v1/runs/:id", async (req) =>
    selected(req).store.require("runs", idParam(req)),
  );
  app.post("/v1/runs/:id/cancel", async (req) =>
    selected(req).cancel(idParam(req)),
  );
  app.get("/v1/runs/:id/trace", async (req) => ({
    trace: selected(req).store.traces(idParam(req)),
    context: selected(req).context(idParam(req)),
  }));
  app.get("/v1/trace", async (req) => {
    const q = z
      .object({ entityId: z.string().min(1).max(150).optional() })
      .parse(req.query);
    return {
      trace: selected(req).store.traces(q.entityId),
      context:
        q.entityId && selected(req).store.get("runs", q.entityId)
          ? selected(req).context(q.entityId)
          : null,
    };
  });
  app.post("/v1/messages/:id/exposure", async (req) => {
    const p = z
      .object({ chars: z.number().int().min(0) })
      .strict()
      .parse(req.body);
    return selected(req).displayed(idParam(req), p.chars);
  });
  app.post("/v1/memory/context-reset", async (req) =>
    selected(req).resetCompanionContext(),
  );
  app.get("/v1/sources/:id", async (req) => {
    const source = selected(req).store.require("sources", idParam(req));
    if (source.deleted) throw new DomainError("not_found", 404);
    return source;
  });
  app.post("/v1/persona-revisions", async (req) => {
    const p = z
      .object({ persona: z.unknown(), expectedRevision: z.number().int() })
      .strict()
      .parse(req.body);
    return selected(req).publishPersona(p.persona, p.expectedRevision);
  });
  app.get("/v1/memory", async (req) => {
    const { q } = z
      .object({ q: z.string().max(100).optional() })
      .parse(req.query);
    return q
      ? selected(req).store.search(q, selected(req).clock.now())
      : selected(req).snapshot().memories;
  });
  app.get("/v1/memory/metrics", async (req) => {
    const p = z
      .object({
        traffic: z.enum(["natural", "synthetic", "unknown"]).optional(),
      })
      .strict()
      .parse(req.query);
    return selected(req).memoryMetrics(p.traffic);
  });
  app.post("/v1/memory/:id/exposure", async (req) => {
    const p = z
      .object({ offerId: z.string().min(1).max(100) })
      .strict()
      .parse(req.body);
    return selected(req).candidateExposure(idParam(req), p.offerId);
  });
  app.post("/v1/memory/search", async (req) => {
    const p = z
      .object({
        query: z.string().min(1).max(100),
        target: z.enum(["facts", "conversation", "episodes"]).default("facts"),
        cursor: z.string().max(1000).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict()
      .parse(req.body);
    const h = selected(req);
    return h.memory.search(
      p.query,
      p.target,
      h.clock.now(),
      Infinity,
      undefined,
      { cursor: p.cursor, limit: p.limit },
    );
  });
  app.get("/v1/memory/summaries", async (req) => {
    const h = selected(req);
    return h.store.memoryEnabled
      ? h.store
          .byStatus("conversation_summaries", ["active"])
          .filter((s) => evidenceValid(h.store, s.inputRefs))
      : [];
  });
  app.get("/v1/memory/summaries/:id/sources", async (req) => {
    const h = selected(req),
      summary = h.store.require("conversation_summaries", idParam(req));
    if (
      summary.status !== "active" ||
      !evidenceValid(h.store, summary.inputRefs)
    )
      throw new DomainError("stale_source", 409);
    return summary.inputRefs.map((ref) => ({
      id: ref.id,
      role: h.store.get("messages", ref.id)?.role,
      text: resolveEvidence(h.store, ref),
    }));
  });
  app.post("/v1/memory/summaries/rebuild", async (req) => {
    const p = z
        .object({ id: z.string(), expectedRevision: z.number().int() })
        .strict()
        .parse(req.body),
      h = selected(req),
      s = h.store.require("conversation_summaries", p.id);
    if (s.revision !== p.expectedRevision)
      throw new DomainError("revision_conflict", 409);
    return h.rebuildConversationSummary(p.id, p.expectedRevision);
  });
  app.get("/v1/memory/:id", async (req) => {
    const m = selected(req).store.require("memories", idParam(req));
    if (
      m.status === "deleted" ||
      m.sources.some(
        (r) =>
          !selected(req).store.get("sources", r.id) ||
          selected(req).store.get("sources", r.id)!.deleted,
      )
    )
      throw new DomainError("not_found", 404);
    return { ...m, historical: m.status === "superseded" };
  });
  app.post("/v1/memory", async (req) => selected(req).addMemory(req.body));
  app.post("/v1/memory/corrections", async (req) => {
    const p = z
      .object({
        id: z.string(),
        expectedRevision: z.number().int(),
        idempotencyKey: z.string().min(1).max(100).optional(),
        changes: z
          .object({
            text: z.string().optional(),
            pinned: z.boolean().optional(),
            decision: z.enum(["confirm", "discard", "later"]).optional(),
          })
          .strict(),
      })
      .strict()
      .parse(req.body);
    return selected(req).reviseMemory(
      p.id,
      p.expectedRevision,
      p.changes,
      p.idempotencyKey,
    );
  });
  app.post("/v1/memory/forget", async (req) => {
    const p = z
      .object({
        sourceIds: z.array(z.string()).max(100).default([]),
        memoryIds: z.array(z.string()).max(100).default([]),
        summaryIds: z.array(z.string()).max(100).default([]),
      })
      .strict()
      .parse(req.body);
    return selected(req).forget(p.sourceIds, p.memoryIds, p.summaryIds);
  });
  app.post("/v1/follow-ups", async (req) =>
    selected(req).createFollowUp(req.body),
  );
  app.post("/v1/follow-up-series", async (req) =>
    selected(req).createSeries(req.body),
  );
  app.post("/v1/follow-up-series/:id/cancel", async (req) => {
    const p = z
      .object({ expectedRevision: z.number().int() })
      .strict()
      .parse(req.body);
    return selected(req).cancelSeries(idParam(req), p.expectedRevision);
  });
  app.post("/v1/follow-ups/:id/action", async (req) => {
    const p = z
      .object({
        expectedRevision: z.number().int(),
        action: z.enum(["cancel", "resolve", "confirm"]),
      })
      .strict()
      .parse(req.body);
    return selected(req).updateFollowUp(
      idParam(req),
      p.expectedRevision,
      p.action,
    );
  });
  app.post("/v1/follow-ups/:id/cancel", async (req) => {
    const p = z
      .object({ expectedRevision: z.number().int() })
      .strict()
      .parse(req.body);
    return selected(req).updateFollowUp(
      idParam(req),
      p.expectedRevision,
      "cancel",
    );
  });
  app.post("/v1/channel", async (req) => {
    const p = z
      .object({ clientId: z.string(), permission: z.string() })
      .strict()
      .parse(req.body);
    return selected(req).channel(p.clientId, p.permission);
  });
  app.get("/v1/deliveries/:id", async (req) =>
    selected(req).store.require("deliveries", idParam(req)),
  );
  app.post("/v1/deliveries/:id/events", async (req) =>
    selected(req).deliveryEvent(idParam(req), req.body),
  );
  app.post("/v1/deliveries/:id/feedback", async (req) => {
    const p = z
      .object({ feedback: z.enum(["liked", "disturbed", "not_seen"]) })
      .strict()
      .parse(req.body);
    return selected(req).feedback(idParam(req), p.feedback);
  });
  app.get("/v1/health", async (req) => ({
    status: "ok",
    modelAdapter: selected(req).modelStatus().adapter,
    configured: selected(req).modelStatus().configured,
    schemaVersion: 1,
    pendingJobs: selected(req)
      .store.list("jobs")
      .filter((j) => j.status === "pending").length,
    failedJobs: selected(req)
      .store.list("jobs")
      .filter((j) => j.status === "failed").length,
    now: selected(req).clock.now(),
  }));
  app.post("/v1/exports", async (req) => selected(req).exportData());
  app.get("/v1/exports/:id", async (req) =>
    selected(req).readExport(idParam(req)),
  );
  app.post("/v1/backups", async (req) => selected(req).backup());
  app.post("/local/v1/maintenance", async (req) => {
    const p = z
      .discriminatedUnion("action", [
        z
          .object({
            action: z.literal("summary.rebuild"),
            day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          })
          .strict(),
        z.object({ action: z.literal("job.retry"), id: z.string() }).strict(),
      ])
      .parse(req.body);
    if (p.action === "summary.rebuild") {
      selected(req).store.tx("summary_unblock", () => {
        const s = selected(req).store.settings();
        s.summaryBlockedDays = s.summaryBlockedDays.filter((d) => d !== p.day);
        s.revision++;
        selected(req).store.saveSettings(s);
      });
      return selected(req).queueSummary(p.day);
    }
    const job = selected(req).store.require("jobs", p.id);
    if (job.status !== "failed") throw new DomainError("job_not_failed", 409);
    if (
      !selected(req).store.sourcesValid(job.sources) ||
      job.epoch !== selected(req).store.settings().epoch
    )
      throw new DomainError("stale_source", 409);
    selected(req).store.put("jobs", {
      ...job,
      status: "pending",
      reason: undefined,
      nextAt: selected(req).clock.now(),
    });
    return { queued: true };
  });
  app.get("/v1/relationships/:id/events", async (req, reply) => {
    relationship(req, idParam(req));
    const query = z.object({ cursor: z.string().optional() }).parse(req.query);
    const initial =
      (typeof req.headers["last-event-id"] === "string"
        ? req.headers["last-event-id"]
        : query.cursor) ?? selected(req).store.cursor();
    selected(req).store.events(initial); // Validate before sending headers.
    if (selected(req).signals.listenerCount("change") >= 20)
      throw new DomainError("too_many_streams", 429);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    let cursor = initial,
      closed = false;
    const write = (chunk: string) => {
      if (closed) return;
      if (reply.raw.writableLength > 262144) {
        cleanup();
        reply.raw.end();
        return;
      }
      reply.raw.write(chunk);
    };
    const flush = () => {
      try {
        for (let batch = 0; batch < 9 && !closed; batch++) {
          const events = selected(req).store.events(cursor);
          for (const event of events) {
            cursor = `${selected(req).store.settings().epoch}:${event.seq}`;
            write(
              `id: ${cursor}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`,
            );
          }
          if (events.length < 500) break;
        }
      } catch {
        write(
          `event: resync\ndata: ${JSON.stringify({ epoch: selected(req).store.settings().epoch })}\n\n`,
        );
        cleanup();
        reply.raw.end();
      }
    };
    const heartbeat = setInterval(() => write(": heartbeat\n\n"), 15000);
    heartbeat.unref();
    const shutdown = () => {
      cleanup();
      reply.raw.end();
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      selected(req).signals.off("change", flush);
      selected(req).signals.off("shutdown", shutdown);
    };
    selected(req).signals.on("change", flush);
    selected(req).signals.on("shutdown", shutdown);
    reply.raw.on("close", cleanup);
    write(": connected\n\n");
    flush();
  });
  app.addHook("preClose", async () => {
    for (const target of options.bots?.all() ?? [harness])
      target.signals.emit("shutdown");
  });
  return app;
}
