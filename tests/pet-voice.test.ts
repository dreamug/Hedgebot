import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";
import { createPetRuntime } from "../src/pet/runtime.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pet-voice-test-")),
    provider = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(provider, "listening");
  const endpoint = `ws://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const seen: {
    config?: any;
    audio: number;
    connections: number;
    closed: number;
    degraded: boolean;
    skipFinal: boolean;
  } = {
    audio: 0,
    connections: 0,
    closed: 0,
    degraded: false,
    skipFinal: false,
  };
  provider.on("connection", (socket) => {
    seen.connections++;
    socket.on("close", () => seen.closed++);
    socket.on("message", (data) => {
      const event = decode(new Uint8Array(data as Buffer)) as any;
      if (event.type === "config") {
        seen.config = event;
        socket.send(encode({ type: "session_started" }));
      }
      if (event.type === "audio") {
        seen.audio += event.data.length;
        socket.send(encode({ type: "draft", turn_index: 0, text: "你好煤球" }));
      }
      if (event.type === "audio_done") {
        if (!seen.skipFinal)
          socket.send(
            encode({
              type: "committed",
              turn_index: 0,
              text: "你好煤球，陪我写代码。",
              degraded: seen.degraded,
            }),
          );
        socket.send(encode({ type: "session_done" }));
        socket.close();
      }
    });
  });
  const runtime = await createPetRuntime(
    stableMemoryConfig({
      dataDir: dir,
      host: "127.0.0.1",
      port: 0,
      baseURL: "https://api.deepseek.com",
      model: "deepseek-flash",
      modelMode: "mock",
      maxRunMs: 2000,
      maxOutputTokens: 300,
      schedulerMs: 50,
    }),
    resolve("."),
    0,
    { openRealtime: () => new WebSocket(endpoint) },
  );
  const boot = await runtime.app.inject({ url: "/bootstrap?botId=meiqiu" }),
    headers = {
      cookie: `harness_pet_session=${boot.cookies[0]!.value}`,
      "x-local-token": boot.json().csrfToken,
      "x-bot-id": "meiqiu",
    };
  const request = (
    method: "GET" | "PUT" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
  ) =>
    runtime.app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
  const setup = () =>
    request("PUT", "/v1/pet/setup", {
      deepseekKey: "test-ds-secret",
      fishAudioKey: "test-fish-secret",
    });
  const ticket = async () => {
    const r = await request("POST", "/v1/pet/voice/sessions", {
      expectedEpoch: runtime.coal.store.settings().epoch,
      sampleRate: 16000,
    });
    expect(r.statusCode).toBe(200);
    return r.json().ticket as string;
  };
  const connect = (ticket: string, origin = runtime.address) =>
    new WebSocket(
      runtime.address.replace("http:", "ws:") + "/v1/pet/voice/live",
      `coal-voice.${ticket}`,
      { headers: { cookie: headers.cookie, origin } },
    );
  return {
    runtime,
    dir,
    seen,
    headers,
    request,
    setup,
    ticket,
    connect,
    async close() {
      await runtime.close();
      for (const c of provider.clients) c.terminate();
      await new Promise<void>((done) => provider.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
describe("桌宠首次设置和实时按住说话", () => {
  it("未设置拦截聊天，必须两把Key一起保存，响应不含Key，语音默认开启", async () => {
    const x = await fixture();
    try {
      expect((await x.request("GET", "/v1/pet/setup")).json()).toMatchObject({
        ready: false,
        preferences: { voiceEnabled: true, autoSpeak: true },
      });
      expect(
        (
          await x.request("POST", "/v1/threads/local-thread/inputs", {
            text: "hello",
            idempotencyKey: "test",
          })
        ).json().error,
      ).toBe("pet_setup_required");
      expect(
        (
          await x.request("PUT", "/v1/pet/setup", {
            deepseekKey: "test-ds-secret",
          })
        ).statusCode,
      ).toBe(400);
      const saved = await x.setup();
      expect(saved.json().ready).toBe(true);
      expect(saved.body).not.toContain("secret");
      expect(x.runtime.coal.store.settings().remoteDisclosureAcknowledged).toBe(
        true,
      );
      const path = join(x.runtime.coal.config.dataDir, "model-keys.json");
      expect(readFileSync(path, "utf8")).toContain("test-fish-secret");
      if (process.platform !== "win32")
        expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(
        (
          await x.request("PUT", "/v1/pet/setup", {
            fishAudioKey: "test-fish-new-secret",
          })
        ).json().ready,
      ).toBe(true);
    } finally {
      await x.close();
    }
  });
  it("真实WebSocket透传PCM，松手前收到字幕，松手后收到最终文本，录音不写聊天", async () => {
    const x = await fixture();
    try {
      await x.setup();
      const socket = x.connect(await x.ticket());
      const events: any[] = [];
      socket.on("message", (data) => events.push(JSON.parse(data.toString())));
      await expect
        .poll(() => events.some((e) => e.type === "ready"))
        .toBe(true);
      socket.send(Buffer.alloc(3200));
      await expect
        .poll(() => events.some((e) => e.type === "transcript" && !e.final))
        .toBe(true);
      expect(events.some((e) => e.type === "done")).toBe(false);
      expect(x.seen.config.turn_detection.mode).toBe("manual");
      expect(x.seen.config.results.drafts).toBe(true);
      socket.send(JSON.stringify({ type: "finish" }));
      await expect
        .poll(() => events.find((e) => e.type === "done")?.text)
        .toBe("你好煤球，陪我写代码。");
      expect(x.seen.audio).toBe(3200);
      expect(x.runtime.coal.snapshot().messages).toHaveLength(0);
    } finally {
      await x.close();
    }
  });
  it("没有CSRF不能申请票据，票据一次性且拒绝外站握手", async () => {
    const x = await fixture();
    try {
      await x.setup();
      expect(
        (
          await x.runtime.app.inject({
            method: "POST",
            url: "/v1/pet/voice/sessions",
            headers: { cookie: x.headers.cookie },
            payload: { expectedEpoch: 1, sampleRate: 16000 },
          })
        ).statusCode,
      ).toBe(403);
      const token = await x.ticket();
      const rejected = x.connect(token, "https://example.com");
      rejected.on("error", () => {});
      const [, res] = await once(rejected, "unexpected-response");
      expect(res.statusCode).toBe(403);
      res.destroy();
      rejected.terminate();
      const socket = x.connect(token);
      socket.on("error", () => {});
      await once(socket, "message");
      socket.close();
      await once(socket, "close");
      const replay = x.connect(token);
      replay.on("error", () => {});
      const [, denied] = await once(replay, "unexpected-response");
      expect(denied.statusCode).toBe(403);
      denied.destroy();
      replay.terminate();
    } finally {
      await x.close();
    }
  });
  it("取消和关闭语音会清理上游；降级转写不作为最终文字发送", async () => {
    const x = await fixture();
    try {
      await x.setup();
      const socket = x.connect(await x.ticket());
      await once(socket, "message");
      socket.close();
      await expect.poll(() => x.seen.closed).toBe(1);
      const next = x.connect(await x.ticket()),
        events: any[] = [];
      next.on("message", (d) => events.push(JSON.parse(d.toString())));
      await expect.poll(() => events[0]?.type).toBe("ready");
      x.seen.degraded = true;
      next.send(Buffer.alloc(3200));
      next.send(JSON.stringify({ type: "finish" }));
      await expect
        .poll(() => events.find((e) => e.type === "error")?.error)
        .toBe("transcription_degraded");
      expect(events.some((e) => e.type === "done")).toBe(false);
      await x.request("PATCH", "/v1/pet/preferences", { voiceEnabled: false });
      expect(
        (
          await x.request("POST", "/v1/pet/voice/sessions", {
            expectedEpoch: x.runtime.coal.store.settings().epoch,
            sampleRate: 16000,
          })
        ).json().error,
      ).toBe("voice_disabled");
    } finally {
      await x.close();
    }
  });
  it("不把草稿当最终文字，隐私epoch变化会立即断开录音", async () => {
    const x = await fixture();
    try {
      await x.setup();
      x.seen.skipFinal = true;
      const socket = x.connect(await x.ticket()),
        events: any[] = [];
      socket.on("message", (d) => events.push(JSON.parse(d.toString())));
      await expect.poll(() => events[0]?.type).toBe("ready");
      socket.send(Buffer.alloc(3200));
      await expect
        .poll(() => events.some((e) => e.type === "transcript"))
        .toBe(true);
      socket.send(JSON.stringify({ type: "finish" }));
      await expect
        .poll(() => events.find((e) => e.type === "done")?.text)
        .toBe("");
      await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
      const next = x.connect(await x.ticket()),
        later: any[] = [];
      next.on("message", (d) => later.push(JSON.parse(d.toString())));
      await expect.poll(() => later[0]?.type).toBe("ready");
      const settings = x.runtime.coal.store.settings();
      x.runtime.coal.store.saveSettings({
        ...settings,
        epoch: settings.epoch + 1,
      });
      await expect
        .poll(() => later.find((e) => e.type === "error")?.error)
        .toBe("epoch_conflict");
      expect(x.runtime.coal.snapshot().messages).toHaveLength(0);
    } finally {
      await x.close();
    }
  });
});
