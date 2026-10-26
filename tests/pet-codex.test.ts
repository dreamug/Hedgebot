import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { CodexPetState, type HookEvent } from "../src/pet/codex-state.js";
import { createCodexBridge } from "../src/pet/codex-bridge.js";

const root = resolve(".");
const at = Date.now();
let sequence = 0;
const event = (patch: Partial<HookEvent> = {}): HookEvent => ({
  schemaVersion: 1,
  eventId: `e-${++sequence}`,
  sessionId: "session-a",
  turnId: "turn-a",
  cwd: root,
  event: "UserPromptSubmit",
  at,
  ...patch,
});
function hook(config: string, payload: unknown) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (done) => {
      const child = spawn(
        process.execPath,
        [resolve("scripts/hedgehog/codex-hook.mjs"), "--config", config],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", (chunk) => (err += String(chunk)));
      child.on("close", (code) => done({ code, out, err }));
      child.stdin.end(JSON.stringify(payload));
    },
  );
}
describe("Codex煤球状态边界", () => {
  it("并行工具按id结束，单个工具完成不结束另一个编辑", () => {
    const state = new CodexPetState(root, () => at);
    state.ingest(event());
    state.bind("session-a");
    state.ingest(
      event({ event: "PreToolUse", toolId: "a", toolKind: "file-edit" }),
    );
    state.ingest(
      event({ event: "PreToolUse", toolId: "b", toolKind: "file-edit" }),
    );
    state.ingest(event({ event: "PostToolUse", toolId: "a" }));
    expect(state.snapshot().selected).toMatchObject({
      phase: "coding",
      activeTools: 1,
    });
    state.ingest(event({ event: "PostToolUse", toolId: "b" }));
    expect(state.snapshot().selected?.phase).toBe("thinking");
  });
  it("其他工具完成不清除尚待审批的编辑", () => {
    const state = new CodexPetState(root, () => at);
    state.ingest(event());
    state.bind("session-a");
    state.ingest(
      event({ event: "PreToolUse", toolId: "edit", toolKind: "file-edit" }),
    );
    state.ingest(event({ event: "PermissionRequest", toolId: "edit" }));
    state.ingest(event({ event: "PostToolUse", toolId: "read" }));
    expect(state.snapshot().selected?.phase).toBe("attention");
    state.ingest(event({ event: "PostToolUse", toolId: "edit" }));
    expect(state.snapshot().selected?.phase).toBe("thinking");
  });
  it("审批hook未提供tool id时，已知编辑完成后能恢复思考", () => {
    const state = new CodexPetState(root, () => at);
    state.ingest(event());
    state.bind("session-a");
    state.ingest(
      event({ event: "PreToolUse", toolId: "edit", toolKind: "file-edit" }),
    );
    state.ingest(event({ event: "PermissionRequest", toolKind: "file-edit" }));
    expect(state.snapshot().selected?.phase).toBe("attention");
    state.ingest(event({ event: "PostToolUse", toolId: "edit" }));
    expect(state.snapshot().selected?.phase).toBe("thinking");
  });
  it("新回合替换活动集合，旧回合及终止后的迟到事件不能复活它", () => {
    const state = new CodexPetState(root, () => at);
    state.ingest(event());
    state.bind("session-a");
    state.ingest(event({ turnId: "turn-b" }));
    expect(state.ingest(event({ event: "Stop" })).accepted).toBe(false);
    state.ingest(event({ event: "Interrupt", turnId: "turn-b" }));
    expect(
      state.ingest(
        event({
          event: "PreToolUse",
          turnId: "turn-b",
          toolId: "late",
          toolKind: "file-edit",
        }),
      ).accepted,
    ).toBe(false);
    expect(state.snapshot().selected).toMatchObject({
      phase: "idle",
      activeTools: 0,
    });
    expect(state.snapshot().selected?.completedAt).toBeUndefined();
  });
  it("Stop只记录回合结束，不声称任何测试通过", () => {
    const state = new CodexPetState(root, () => at);
    state.ingest(event());
    state.bind("session-a");
    state.ingest(event({ event: "Stop" }));
    expect(state.snapshot().selected).toMatchObject({
      phase: "idle",
      completedAt: at,
    });
    expect(JSON.stringify(state.snapshot())).not.toMatch(
      /passed|success|testResult/,
    );
  });
  it("事件去重、不自动绑定会话、陈旧状态不推成任务完成", () => {
    let now = at;
    const state = new CodexPetState(root, () => now);
    const e = event();
    state.ingest(e);
    expect(state.ingest(e).reason).toBe("duplicate");
    expect(state.snapshot().connection).toBe("unbound");
    expect(state.bind("missing")).toBe(false);
    state.bind("session-a");
    state.ingest(
      event({ event: "PreToolUse", toolId: "edit", toolKind: "file-edit" }),
    );
    now += 61000;
    expect(state.snapshot()).toMatchObject({
      connection: "stale",
      selected: { phase: "coding" },
    });
    expect(state.snapshot().selected?.completedAt).toBeUndefined();
  });
  it("拒绝其他项目、越界时间戳、正文和源码字段", () => {
    const state = new CodexPetState(root, () => at);
    expect(state.ingest(event({ cwd: tmpdir() })).reason).toBe("other_project");
    expect(state.ingest(event({ at: at - 31000 })).reason).toBe("stale_event");
    expect(() =>
      state.ingest({
        ...event(),
        prompt: "SECRET",
        tool_input: { command: "SOURCE" },
      }),
    ).toThrow();
    expect(state.snapshot().sessions).toEqual([]);
  });
  it("项目目录通过真实路径判断，符号链接不能逃出边界", () => {
    const dir = mkdtempSync(join(tmpdir(), "pet-scope-"));
    try {
      mkdirSync(join(dir, "project"));
      mkdirSync(join(dir, "other"));
      symlinkSync(
        join(dir, "other"),
        join(dir, "project/link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const state = new CodexPetState(join(dir, "project"), () => at);
      expect(
        state.ingest(event({ cwd: join(dir, "project/link") })).accepted,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("会话状态有上限，已绑定的会话不被其他会话挤掉", () => {
    const state = new CodexPetState(root, () => at);
    state.ingest(event());
    state.bind("session-a");
    for (let i = 0; i < 40; i++)
      state.ingest(event({ sessionId: `other-${i}` }));
    expect(state.snapshot().sessions).toHaveLength(24);
    expect(state.snapshot().selected?.sessionId).toBe("session-a");
  });
});
describe("Codex本地观察桥", () => {
  it("安装与移除幂等，原有hooks定义不被覆盖", () => {
    const dir = mkdtempSync(join(tmpdir(), "pet-install-"));
    try {
      mkdirSync(join(dir, "scripts/hedgehog"), { recursive: true });
      mkdirSync(join(dir, ".codex"));
      const installer = join(dir, "scripts/hedgehog/install-hooks.mjs");
      copyFileSync(resolve("scripts/hedgehog/install-hooks.mjs"), installer);
      const original = {
        description: "user definitions",
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "echo original", timeout: 2 },
              ],
            },
          ],
        },
      };
      const path = join(dir, ".codex/hooks.json");
      writeFileSync(path, JSON.stringify(original));
      const run = (args: string[] = []) =>
        execFileSync(process.execPath, [installer, ...args], {
          encoding: "utf8",
        });
      run();
      run();
      let result = JSON.parse(readFileSync(path, "utf8"));
      expect(result.hooks.Stop).toHaveLength(2);
      expect(result.hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
      expect(result.hooks.UserPromptSubmit).toHaveLength(1);
      run(["--remove"]);
      result = JSON.parse(readFileSync(path, "utf8"));
      expect(result.hooks.Stop).toEqual(original.hooks.Stop);
      expect(result.description).toBe(original.description);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("token与Origin边界独立于浏览器Cookie，并校验输入", async () => {
    const bridge = await createCodexBridge(root);
    try {
      const headers = {
        host: new URL(bridge.address).host,
        authorization: `Bearer ${bridge.token}`,
      };
      expect(
        (
          await bridge.app.inject({
            method: "POST",
            url: "/events",
            headers: { host: headers.host },
            payload: event(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await bridge.app.inject({
            method: "POST",
            url: "/events",
            headers: { ...headers, origin: bridge.address },
            payload: event(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await bridge.app.inject({
            method: "POST",
            url: "/events",
            headers,
            payload: { ...event(), transcript_path: "/private/path" },
          })
        ).statusCode,
      ).toBe(400);
      const r = await bridge.app.inject({
        method: "POST",
        url: "/events",
        headers,
        payload: event(),
      });
      expect(r.json()).toEqual({ accepted: true });
      expect(r.body).not.toContain(bridge.token);
    } finally {
      await bridge.app.close();
    }
  });
  it("真实hook进程只发送白名单元数据，输出不会改变Codex决策", async () => {
    const bridge = await createCodexBridge(root),
      dir = mkdtempSync(join(tmpdir(), "pet-hook-"));
    try {
      const config = join(dir, "bridge.json");
      writeFileSync(
        config,
        JSON.stringify({
          address: `${bridge.address}/events`,
          token: bridge.token,
        }),
        { mode: 0o600 },
      );
      const result = await hook(config, {
        hook_event_name: "PreToolUse",
        session_id: "hook-session",
        turn_id: "hook-turn",
        tool_use_id: "edit",
        tool_name: "apply_patch",
        cwd: root,
        prompt: "DO_NOT_FORWARD",
        transcript_path: "DO_NOT_READ",
        tool_input: { command: "PRIVATE_SOURCE" },
        tool_response: "PRIVATE_OUTPUT",
      });
      expect(result).toEqual({ code: 0, out: "{}\n", err: "" });
      bridge.state.bind("hook-session");
      expect(bridge.state.snapshot().selected).toMatchObject({
        phase: "coding",
        activeTools: 1,
      });
      expect(JSON.stringify(bridge.state.snapshot())).not.toMatch(
        /DO_NOT_|PRIVATE_/,
      );
    } finally {
      await bridge.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("桥离线或配置无效时快速退出，仍输出空对象", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pet-hook-offline-"));
    try {
      const config = join(dir, "bridge.json");
      writeFileSync(
        config,
        JSON.stringify({
          address: "http://127.0.0.1:1/events",
          token: "a".repeat(64),
        }),
        { mode: 0o600 },
      );
      const began = Date.now();
      const result = await hook(config, {
        hook_event_name: "UserPromptSubmit",
        session_id: "offline",
        turn_id: "turn",
        cwd: root,
      });
      expect(result).toEqual({ code: 0, out: "{}\n", err: "" });
      expect(Date.now() - began).toBeLessThan(1200);
      expect(await hook(join(dir, "missing.json"), {})).toEqual({
        code: 0,
        out: "{}\n",
        err: "",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
