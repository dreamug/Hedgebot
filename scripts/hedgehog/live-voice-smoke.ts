import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { loadConfig } from "../../src/config.js";
import { FishAudioSpeech } from "../../src/speech.js";
import { stableMemoryConfig } from "../../src/memory/stable-config.js";
import { createPetRuntime } from "../../src/pet/runtime.js";
const output = resolve("local-data/hedgehog-verification"),
  dir = mkdtempSync(join(tmpdir(), "coal-live-voice-"));
mkdirSync(output, { recursive: true, mode: 0o700 });
const config = stableMemoryConfig(
  loadConfig({
    dataDir: dir,
    port: 0,
    transcriptionMode: "fish",
    modelMode: "deepseek",
    trafficOrigin: "synthetic",
  }),
);
const source =
  "你好煤球，我今天在写代码，想让你陪我一起找一找问题，然后我们再聊聊今天发生的事。";
let runtime: Awaited<ReturnType<typeof createPetRuntime>> | undefined;
try {
  if (!config.fishAudioApiKey || !config.apiKey)
    throw Error("live_credentials_missing");
  const mp3 = join(output, "synthetic-voice.mp3"),
    pcm = join(output, "synthetic-voice.pcm");
  if (!existsSync(mp3))
    writeFileSync(
      mp3,
      await new FishAudioSpeech(config).synthesize(
        source,
        AbortSignal.timeout(50000),
      ),
      { mode: 0o600 },
    );
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      mp3,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-f",
      "s16le",
      pcm,
    ],
    { stdio: "pipe" },
  );
  runtime = await createPetRuntime(config, resolve("."));
  const boot = await runtime.app.inject({ url: "/bootstrap?botId=meiqiu" }),
    headers = {
      cookie: `harness_pet_session=${boot.cookies[0]!.value}`,
      "x-local-token": boot.json().csrfToken,
      "x-bot-id": "meiqiu",
    };
  const configured = await runtime.app.inject({
    method: "PUT",
    url: "/v1/pet/setup",
    headers,
    payload: {
      deepseekKey: config.apiKey,
      fishAudioKey: config.fishAudioApiKey,
    },
  });
  if (configured.statusCode !== 200) throw Error("voice_setup_failed");
  const ticket = await runtime.app.inject({
    method: "POST",
    url: "/v1/pet/voice/sessions",
    headers,
    payload: {
      expectedEpoch: runtime.coal.store.settings().epoch,
      sampleRate: 16000,
    },
  });
  if (ticket.statusCode !== 200) throw Error("voice_session_rejected");
  const session = ticket.json(),
    audio = readFileSync(pcm),
    started = Date.now();
  let firstDraftMs: number | undefined,
    finishAt = 0,
    bytes = 0;
  const result = await new Promise<string>((done, reject) => {
    const socket = new WebSocket(
      runtime!.address.replace("http:", "ws:") + session.path,
      `coal-voice.${session.ticket}`,
      { headers: { cookie: headers.cookie, origin: runtime!.address } },
    );
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(Error("live_voice_timeout"));
    }, 60000);
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: Error, text?: string) => {
      clearTimeout(timeout);
      clearInterval(timer);
      socket.close();
      error ? reject(error) : done(text!);
    };
    socket.on("error", () => finish(Error("live_voice_connection_failed")));
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "ready")
        timer = setInterval(() => {
          if (bytes < audio.length) {
            socket.send(audio.subarray(bytes, bytes + 3200));
            bytes += 3200;
          } else {
            clearInterval(timer);
            finishAt = Date.now();
            socket.send(JSON.stringify({ type: "finish" }));
          }
        }, 100);
      if (
        event.type === "transcript" &&
        !event.final &&
        event.text &&
        !firstDraftMs
      )
        firstDraftMs = Date.now() - started;
      if (event.type === "done") finish(undefined, event.text);
      if (event.type === "error") finish(Error(event.error));
    });
  });
  const asrElapsed = Date.now() - started,
    releaseToFinalMs = Date.now() - finishAt;
  const input = await runtime.app.inject({
    method: "POST",
    url: "/v1/threads/local-thread/inputs",
    headers,
    payload: { text: result, idempotencyKey: crypto.randomUUID() },
  });
  if (input.statusCode !== 200) throw Error("voice_chat_submit_failed");
  const runId = input.json().runId,
    chatBegan = Date.now();
  while (
    ["queued", "running"].includes(
      runtime.coal.store.require("runs", runId).status,
    )
  ) {
    if (Date.now() - chatBegan > 90000) throw Error("voice_chat_timeout");
    await new Promise((done) => setTimeout(done, 30));
  }
  const run = runtime.coal.store.require("runs", runId),
    reply = runtime.coal
      .snapshot()
      .messages.find(
        (m) =>
          m.role === "assistant" &&
          m.runId === runId &&
          m.status === "completed",
      );
  if (run.status !== "completed" || !reply) throw Error("voice_chat_failed");
  const chatElapsedMs = Date.now() - chatBegan,
    ttsBegan = Date.now();
  const speech = await runtime.app.inject({
    method: "POST",
    url: "/v1/speech",
    headers,
    payload: {
      kind: "message",
      id: reply.id,
      expectedRevision: reply.revision,
      expectedEpoch: runtime.coal.store.settings().epoch,
    },
  });
  if (
    speech.statusCode !== 200 ||
    speech.rawPayload.length < 1000 ||
    !String(speech.headers["content-type"]).startsWith("audio/mpeg")
  )
    throw Error("voice_reply_audio_failed");
  const report = {
    passed: Boolean(
      firstDraftMs && result.includes("煤球") && result.includes("代码"),
    ),
    source,
    transcript: result,
    firstDraftMs,
    releaseToFinalMs,
    elapsedMs: asrElapsed,
    chat: {
      model: config.model,
      status: run.status,
      elapsedMs: chatElapsedMs,
      reply: reply.content,
    },
    speech: {
      provider: "Fish Audio",
      mp3Bytes: speech.rawPayload.length,
      elapsedMs: Date.now() - ttsBegan,
    },
    audioSeconds: audio.length / 32000,
    liveDraftBeforeRelease: Boolean(
      firstDraftMs && started + firstDraftMs < finishAt,
    ),
    provider: "Fish Audio transcribe-stream-1",
    input: "synthetic speech, no human microphone recording",
  };
  writeFileSync(
    join(output, "live-voice.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.log(
    JSON.stringify({
      passed: false,
      error: error instanceof Error ? error.message : "live_voice_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await runtime?.close();
  rmSync(dir, { recursive: true, force: true });
}
