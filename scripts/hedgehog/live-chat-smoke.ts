import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../../src/config.js";
import { stableMemoryConfig } from "../../src/memory/stable-config.js";
import { createPetRuntime } from "../../src/pet/runtime.js";

// One synthetic message in a disposable database. Never opens the user's chats.
const dir = mkdtempSync(join(tmpdir(), "coal-live-smoke-"));
const config = stableMemoryConfig(
  loadConfig({ dataDir: dir, port: 0, trafficOrigin: "synthetic" }),
);
const runtime = await createPetRuntime(config, resolve("."));
const output = resolve("local-data/hedgehog-verification");
mkdirSync(output, { recursive: true, mode: 0o700 });
try {
  if (config.modelMode === "mock" || !runtime.coal.modelStatus().configured) {
    console.log(
      JSON.stringify({ skipped: true, reason: "live_provider_not_configured" }),
    );
  } else {
    runtime.coal.store.saveSettings({
      ...runtime.coal.store.settings(),
      remoteDisclosureAcknowledged: true,
    });
    const began = Date.now();
    const accepted = runtime.coal.submit(
      "你好煤球，请用一句话介绍一下自己。不要保存这条测试消息。",
      crypto.randomUUID(),
    );
    while (
      ["queued", "running"].includes(
        runtime.coal.store.require("runs", accepted.runId).status,
      )
    ) {
      if (Date.now() - began > 90_000) throw new Error("live_chat_timeout");
      await new Promise((done) => setTimeout(done, 25));
    }
    const run = runtime.coal.store.require("runs", accepted.runId);
    const reply = runtime.coal.store.get(
      "messages",
      `assistant-${accepted.runId}`,
    );
    const report = {
      passed: run.status === "completed",
      model: config.model,
      runStatus: run.status,
      reason: run.reason,
      elapsedMs: Date.now() - began,
      reply: reply?.content ?? "",
      calls: run.usage.calls,
    };
    writeFileSync(
      join(output, "live-chat.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report));
    if (!report.passed) process.exitCode = 1;
  }
} finally {
  await runtime.close();
  rmSync(dir, { recursive: true, force: true });
}
