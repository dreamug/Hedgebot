import { randomBytes } from "node:crypto";
import { encode, decode } from "@msgpack/msgpack";
import WebSocket from "ws";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Harness } from "../harness.js";
import type { ModelCredentials } from "../model-config.js";
import { DomainError } from "../domain.js";

/** One press owns one short lived, manual-turn ASR connection. No audio is persisted. */
export async function registerPetVoice(
  app: FastifyInstance,
  coal: Harness,
  credentials: ModelCredentials,
  enabled: () => boolean,
  connect = (key: string) =>
    new WebSocket("wss://api.fish.audio/v1/asr/realtime", {
      headers: { Authorization: `Bearer ${key}`, model: "transcribe-stream-1" },
      handshakeTimeout: 12000,
      maxPayload: 1024 * 1024,
    }),
) {
  const allowed = () =>
    enabled() &&
    credentials.petSetupStatus().ready &&
    coal.store.settings().remoteDisclosureAcknowledged;
  const tickets = new Map<
    string,
    { expires: number; epoch: number; sampleRate: number }
  >();
  const sockets = new Set<WebSocket>();
  let active: WebSocket | undefined;
  app.post("/v1/pet/voice/sessions", async (req) => {
    const input = z
      .object({
        expectedEpoch: z.number().int(),
        sampleRate: z.union([
          z.literal(16000),
          z.literal(48000),
          z.literal(44100),
          z.literal(24000),
          z.literal(32000),
          z.literal(8000),
          z.literal(12000),
          z.literal(22050),
        ]),
      })
      .strict()
      .parse(req.body);
    if (!credentials.petSetupStatus().ready)
      throw new DomainError("pet_setup_required", 409);
    if (!allowed()) throw new DomainError("voice_disabled", 409);
    if (input.expectedEpoch !== coal.store.settings().epoch)
      throw new DomainError("epoch_conflict", 409);
    for (const [key, value] of tickets)
      if (value.expires < Date.now()) tickets.delete(key);
    if (tickets.size >= 8) throw new DomainError("voice_busy", 429);
    const ticket = randomBytes(32).toString("hex");
    tickets.set(ticket, {
      ...input,
      epoch: input.expectedEpoch,
      expires: Date.now() + 30000,
    });
    return { ticket, path: "/v1/pet/voice/live" };
  });
  app.get(
    "/v1/pet/voice/live",
    {
      websocket: true,
      preValidation: async (req) => {
        const protocol = req.headers["sec-websocket-protocol"];
        const ticket =
          typeof protocol === "string"
            ? protocol.replace(/^coal-voice\./, "")
            : "";
        const config = tickets.get(ticket);
        if (
          !config ||
          config.expires < Date.now() ||
          config.epoch !== coal.store.settings().epoch ||
          !allowed()
        )
          throw new DomainError("voice_ticket_invalid", 403);
        if (active) throw new DomainError("voice_busy", 409);
      },
    },
    (socket, req) => {
      const ticket = req.headers["sec-websocket-protocol"]!.replace(
        /^coal-voice\./,
        "",
      );
      const config = tickets.get(ticket)!;
      tickets.delete(ticket);
      active = socket;
      sockets.add(socket);
      let upstream: WebSocket | undefined,
        ready = false,
        finished = false,
        done = false,
        bytes = 0;
      const turns = new Map<number, string>();
      const committed = new Map<number, string>();
      const send = (value: unknown) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify(value));
      };
      const close = () => {
        clearInterval(guard);
        clearTimeout(deadline);
        if (active === socket) active = undefined;
        sockets.delete(socket);
        if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
        else upstream?.close();
      };
      const fail = (error: string) => {
        if (done) return;
        done = true;
        send({ type: "error", error });
        socket.close(1011);
        close();
      };
      const guard = setInterval(() => {
        if (config.epoch !== coal.store.settings().epoch || !allowed())
          fail("epoch_conflict");
      }, 250);
      const deadline = setTimeout(() => fail("transcription_timeout"), 70000);
      socket.on("close", close);
      socket.on("error", close);
      socket.on("message", (data, binary) => {
        if (done) return;
        if (config.epoch !== coal.store.settings().epoch || !allowed())
          return fail("epoch_conflict");
        if (!ready || !upstream || upstream.readyState !== WebSocket.OPEN)
          return fail("transcription_not_ready");
        if (binary) {
          const chunk = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          bytes += chunk.length;
          if (
            finished ||
            bytes > config.sampleRate * 2 * 46 ||
            upstream.bufferedAmount > 1024 * 1024
          )
            return fail("transcription_audio_too_large");
          upstream.send(encode({ type: "audio", data: new Uint8Array(chunk) }));
        } else {
          try {
            const value = JSON.parse(data.toString());
            if (value.type !== "finish" || finished)
              return fail("transcription_protocol_error");
            finished = true;
            upstream.send(encode({ type: "audio_done" }));
          } catch {
            fail("transcription_protocol_error");
          }
        }
      });
      try {
        upstream = connect(credentials.fishAudioKey()!);
      } catch {
        fail("transcription_unavailable");
        return;
      }
      upstream.on("open", () =>
        upstream!.send(
          encode({
            type: "config",
            audio: {
              format: "pcm_s16le",
              sample_rate: config.sampleRate,
              channels: 1,
            },
            turn_detection: { mode: "manual" },
            results: { drafts: true, diarize: false },
          }),
        ),
      );
      upstream.on("unexpected-response", (_req, response) => {
        response.destroy();
        fail(
          response.statusCode === 401
            ? "transcription_authentication_failed"
            : response.statusCode === 402
              ? "transcription_balance_insufficient"
              : "transcription_unavailable",
        );
      });
      upstream.on("error", () => fail("transcription_unavailable"));
      upstream.on("close", () => {
        if (!done) fail("transcription_connection_lost");
      });
      upstream.on("message", (data) => {
        if (done) return;
        try {
          const event = decode(new Uint8Array(data as Buffer)) as Record<
            string,
            unknown
          >;
          if (event.type === "session_started") {
            ready = true;
            send({ type: "ready" });
          }
          if (event.type === "draft" || event.type === "committed") {
            if (event.degraded === true) return fail("transcription_degraded");
            if (
              typeof event.text !== "string" ||
              typeof event.turn_index !== "number"
            )
              return fail("transcription_protocol_error");
            if (event.type === "committed" && event.user_turn !== false)
              committed.set(event.turn_index, event.text.slice(0, 4000));
            turns.set(event.turn_index, event.text.slice(0, 4000));
            const text = [...turns]
              .sort((a, b) => a[0] - b[0])
              .map(([, text]) => text)
              .join("")
              .slice(0, 4000);
            send({
              type: "transcript",
              text,
              final: event.type === "committed",
            });
          }
          if (event.type === "error") fail("transcription_unavailable");
          if (event.type === "session_done") {
            if (!finished) return fail("transcription_connection_lost");
            done = true;
            send({
              type: "done",
              text: [...committed]
                .sort((a, b) => a[0] - b[0])
                .map(([, text]) => text)
                .join("")
                .trim()
                .slice(0, 4000),
            });
            socket.close(1000);
            close();
          }
        } catch {
          fail("transcription_protocol_error");
        }
      });
    },
  );
  app.addHook("preClose", async () => {
    for (const socket of sockets) socket.terminate();
    tickets.clear();
  });
}
