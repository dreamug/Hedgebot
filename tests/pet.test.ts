import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createPetRuntime } from "../src/pet/runtime.js";
import { stableMemoryConfig } from "../src/memory/stable-config.js";
import type { AppConfig } from "../src/config.js";
const root = resolve(".");
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pet-runtime-"));
  const config = stableMemoryConfig({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    baseURL: "https://api.deepseek.com",
    model: "deepseek-flash",
    modelMode: "mock",
    maxRunMs: 2000,
    maxOutputTokens: 300,
    schedulerMs: 50,
  } satisfies AppConfig);
  const runtime = await createPetRuntime(config, root);
  const boot = await runtime.app.inject({ url: "/bootstrap?botId=meiqiu" });
  const headers = {
    cookie: `harness_pet_session=${boot.cookies[0]!.value}`,
    "x-local-token": boot.json().csrfToken,
    "x-bot-id": "meiqiu",
  };
  return {
    ...runtime,
    config,
    dir,
    headers,
    boot: boot.json(),
    async dispose() {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
describe("煤球桌宠复用bot服务", () => {
  it("ready后立即提交也会被唤醒，不能滞留在CM3队列", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pet-immediate-"));
    const config = stableMemoryConfig({
      dataDir: dir,
      host: "127.0.0.1",
      port: 0,
      baseURL: "https://api.deepseek.com",
      model: "deepseek-flash",
      modelMode: "mock",
      maxRunMs: 2000,
      maxOutputTokens: 300,
      schedulerMs: 50,
    } satisfies AppConfig);
    const runtime = await createPetRuntime(config, root);
    try {
      const accepted = runtime.coal.submit(
        "刚启动就收到的消息",
        crypto.randomUUID(),
      );
      const began = Date.now();
      while (
        ["queued", "running"].includes(
          runtime.coal.store.require("runs", accepted.runId).status,
        )
      ) {
        if (Date.now() - began > 2500) throw Error("input_was_not_drained");
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(runtime.coal.store.require("runs", accepted.runId).status).toBe(
        "completed",
      );
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("独立身份、记忆与Cookie，不覆盖原Web会话", async () => {
    const x = await setup();
    try {
      expect(x.bots.list().map((b) => b.id)).toEqual(["xiaoye", "meiqiu"]);
      expect(x.coal.store.settings().persona.name).toBe("煤球");
      const b = await x.app.inject({ url: "/bootstrap?botId=meiqiu" });
      expect(b.cookies[0]!.name).toBe("harness_pet_session");
      const s = await x.app.inject({
        url: "/v1/relationships/bot-meiqiu/snapshot",
        headers: x.headers,
      });
      expect(s.json().scope.relationshipId).toBe("bot-meiqiu");
      expect(s.json().companionMemory.proactive).toBe(false);
      expect(x.coal.config.dataDir).not.toBe(
        x.bots.get("xiaoye").config.dataDir,
      );
    } finally {
      await x.dispose();
    }
  });
  it("只公开列举的动画资源，私有接口仍需会话与CSRF", async () => {
    const x = await setup();
    try {
      for (const url of [
        "/pet",
        "/pet/chat",
        "/pet/art/manifest.json",
        "/pet/art/sheets/sign.png",
      ])
        expect((await x.app.inject({ url })).statusCode).toBe(200);
      expect(
        (await x.app.inject({ url: "/pet/config.json" })).json(),
      ).toMatchObject({ kind: "hedgehog-desktop-v1", mode: "mock" });
      expect((await x.app.inject({ url: "/v1/pet/codex" })).statusCode).toBe(
        401,
      );
      expect(
        (
          await x.app.inject({
            method: "POST",
            url: "/v1/pet/codex/bind",
            headers: { cookie: x.headers.cookie },
            payload: { sessionId: null },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await x.app.inject({
            url: "/pet/chat",
            headers: { origin: "https://other.example" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await x.app.inject({ url: "/pet/art/env.local", headers: x.headers }))
          .statusCode,
      ).toBe(404);
    } finally {
      await x.dispose();
    }
  });
  it("同一幂等键不会重复发消息，聊天不会混入原角色", async () => {
    const x = await setup();
    try {
      const s = x.coal.store.settings();
      x.coal.store.saveSettings({ ...s, remoteDisclosureAcknowledged: true });
      const input = {
        method: "POST" as const,
        url: "/v1/threads/local-thread/inputs",
        headers: x.headers,
        payload: { text: "你好煤球", idempotencyKey: "pet-idempotent" },
      };
      const first = await x.app.inject(input),
        second = await x.app.inject(input);
      expect(first.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        duplicate: true,
        runId: first.json().runId,
      });
      await x.coal.waitForIdle();
      expect(x.coal.snapshot().runs[0]?.status).toBe("completed");
      expect(
        x.coal.snapshot().messages.find((m) => m.role === "assistant")?.content,
      ).toContain("[本地模拟]");
      expect(
        x.coal.snapshot().messages.filter((m) => m.role === "user"),
      ).toHaveLength(1);
      expect(x.bots.get("xiaoye").snapshot().messages).toEqual([]);
    } finally {
      await x.dispose();
    }
  });
  it("桥接凭据只在本机0600文件，前端拿不到token", async () => {
    const x = await setup();
    try {
      const path = join(x.dir, "codex-bridge.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const config = JSON.parse(readFileSync(path, "utf8"));
      const response = await x.app.inject({
        url: "/v1/pet/codex",
        headers: x.headers,
      });
      expect(response.body).not.toContain(config.token);
      expect(response.json().connection).toBe("waiting");
      expect(
        (
          await x.app.inject({
            method: "POST",
            url: "/v1/pet/codex/bind",
            headers: x.headers,
            payload: { sessionId: "missing" },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await x.dispose();
    }
  });
  it("浏览器动作通道需CSRF，重复命令只保留一次，不写聊天记忆", async () => {
    const x = await setup();
    try {
      const body = { type: "action", id: "cake", nonce: crypto.randomUUID() };
      expect(
        (
          await x.app.inject({
            method: "POST",
            url: "/v1/pet/control",
            payload: body,
          })
        ).statusCode,
      ).toBe(401);
      for (let i = 0; i < 2; i++)
        expect(
          (
            await x.app.inject({
              method: "POST",
              url: "/v1/pet/control",
              headers: x.headers,
              payload: body,
            })
          ).statusCode,
        ).toBe(200);
      const state = (
        await x.app.inject({ url: "/v1/pet/codex", headers: x.headers })
      ).json();
      expect(state.controls).toHaveLength(1);
      expect(x.coal.snapshot().messages).toEqual([]);
      expect(x.coal.snapshot().memories).toEqual([]);
    } finally {
      await x.dispose();
    }
  });
  it("重启保留煤球人格设置与聊天，关闭后释放实例锁", async () => {
    const x = await setup();
    let second: Awaited<ReturnType<typeof createPetRuntime>> | undefined;
    try {
      x.coal.store.saveSettings({ ...x.coal.store.settings(), focused: true });
      await x.close();
      second = await createPetRuntime(x.config, root);
      expect(second.coal.store.settings().focused).toBe(true);
      expect(second.coal.store.settings().persona.name).toBe("煤球");
      expect(second.bots.list()).toHaveLength(2);
    } finally {
      await second?.close();
      await x.dispose();
    }
  });
});
