import { _electron, chromium, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createPetRuntime } from "../../src/pet/runtime.js";
import { stableMemoryConfig } from "../../src/memory/stable-config.js";
import { PetMockModel } from "../../src/pet/mock-model.js";

const root = resolve("."),
  dir = mkdtempSync(join(tmpdir(), "coal-desktop-smoke-"));
const output = resolve("local-data/hedgehog-verification");
mkdirSync(output, { recursive: true, mode: 0o700 });
const electronPath = createRequire(import.meta.url)("electron") as string;
const runtime = await createPetRuntime(
  stableMemoryConfig({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    baseURL: "https://api.deepseek.com",
    model: "deepseek-flash",
    modelMode: "mock",
    maxRunMs: 8000,
    maxOutputTokens: 300,
    schedulerMs: 100,
  }),
  root,
  0,
  { modelFactory: () => new PetMockModel(100) },
);
let native: Awaited<ReturnType<typeof _electron.launch>> | undefined;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks: string[] = [];
async function hook(event: string, tool?: string) {
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve("scripts/hedgehog/codex-hook.mjs"),
        "--config",
        join(dir, "codex-bridge.json"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("close", (code) => {
      if (code !== 0 || out !== "{}\n" || err)
        reject(new Error("hook observer failed"));
      else done();
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: event,
        session_id: "desktop-smoke-session",
        turn_id: "desktop-smoke-turn",
        cwd: root,
        ...(tool ? { tool_name: "apply_patch", tool_use_id: tool } : {}),
        prompt: "Must never be forwarded",
        tool_input: { command: "Must never be forwarded" },
      }),
    );
  });
}
try {
  await page.goto(`${runtime.address}/pet/chat`);
  await expect(page.locator("#connection")).toContainText("在呢");
  await page.locator("#allow-chat").click();
  await expect(page.locator("#disclosure")).toBeHidden();
  await page.locator("#draft").fill("刷新后还在的草稿");
  await page.reload();
  await expect(page.locator("#connection")).toContainText("在呢");
  await expect(page.locator("#draft")).toHaveValue("刷新后还在的草稿");
  checks.push("draft-survives-reload");
  await page.locator("#draft").fill("你好，陪我写会儿代码。");
  await page.locator("#send").click();
  await expect(page.locator(".message.assistant")).toHaveCount(1, {
    timeout: 15000,
  });
  await expect(page.locator(".message.assistant .message-text")).toContainText(
    "[本地模拟]",
  );
  expect(runtime.coal.snapshot().runs[0]?.status).toBe("completed");
  expect(runtime.bots.get("xiaoye").snapshot().messages).toHaveLength(0);
  checks.push("chat-response-and-bot-isolation");
  await page.locator("#draft").fill("这段先暂停一下。");
  await page.locator("#send").click();
  await page.locator("#cancel-run").click();
  await expect(page.locator("#cancel-run")).toBeHidden();
  expect(runtime.coal.snapshot().runs[0]?.status).toBe("cancelled");
  checks.push("cancel-reply");
  await page.locator("#focus").check();
  await expect.poll(() => runtime.coal.store.settings().focused).toBe(true);
  await page.locator("#focus").uncheck();
  await page.screenshot({
    path: join(output, "chat-browser.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  checks.push("focused-mode-and-mobile-layout");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.PET_BACKEND_URL = runtime.address;
  env.PET_DATA_DIR = dir;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  native = await _electron.launch({
    executablePath: electronPath,
    args: [resolve("desktop/main.cjs")],
    env,
    timeout: 30000,
  });
  // Window discovery can arrive in either order after both loadURL calls.
  await expect
    .poll(
      () =>
        native!
          .windows()
          .map((w) => w.url())
          .includes(`${runtime.address}/pet`),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        native!
          .windows()
          .map((w) => w.url())
          .includes(`${runtime.address}/pet/chat`),
      { timeout: 15000 },
    )
    .toBe(true);
  const pet = native
    .windows()
    .find((w) => w.url() === `${runtime.address}/pet`)!;
  const chat = native
    .windows()
    .find((w) => w.url() === `${runtime.address}/pet/chat`)!;
  for (const window of [pet, chat])
    window.on("pageerror", (e) => errors.push(e.message));
  await expect(pet.locator("#coal")).toHaveAttribute("data-connected", "true");
  const flags = await native.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith("/pet"),
    )!;
    const prefs = (
      win.webContents as unknown as {
        getLastWebPreferences: () => {
          nodeIntegration: boolean;
          contextIsolation: boolean;
          sandbox: boolean;
        };
      }
    ).getLastWebPreferences();
    return {
      alwaysOnTop: win.isAlwaysOnTop(),
      shadow: win.hasShadow(),
      nodeIntegration: prefs.nodeIntegration,
      contextIsolation: prefs.contextIsolation,
      sandbox: prefs.sandbox,
    };
  });
  expect(flags).toEqual({
    alwaysOnTop: true,
    shadow: false,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  });
  expect(
    await pet.evaluate(
      () => typeof (window as unknown as { require?: unknown }).require,
    ),
  ).toBe("undefined");
  checks.push("native-two-windows-and-sandbox");
  await pet.evaluate(() =>
    (
      window as unknown as {
        coalDesktop: { setSize: (size: number) => Promise<unknown> };
      }
    ).coalDesktop.setSize(64),
  );
  await expect(pet.locator("#coal")).toHaveCSS("width", "64px");
  await pet.evaluate(() =>
    (
      window as unknown as {
        coalDesktop: { setSize: (size: number) => Promise<unknown> };
      }
    ).coalDesktop.setSize(128),
  );
  await expect(pet.locator("#coal")).toHaveCSS("width", "128px");
  checks.push("native-resize-64-and-128");
  await native.evaluate(({ ipcMain }) => {
    const state = globalThis as unknown as { coalHitEvents: boolean[] };
    state.coalHitEvents = [];
    ipcMain.on("coal:interactive", (_event, value) =>
      state.coalHitEvents.push(value),
    );
  });
  const rect = await pet.locator("#coal").boundingBox();
  if (!rect) throw Error("missing pet canvas");
  await pet.mouse.move(rect.x + 70, rect.y + 85);
  await expect
    .poll(() =>
      native!.evaluate(() =>
        (
          globalThis as unknown as { coalHitEvents: boolean[] }
        ).coalHitEvents.at(-1),
      ),
    )
    .toBe(true);
  await pet.mouse.move(rect.x + 2, rect.y + 2);
  await expect
    .poll(() =>
      native!.evaluate(() =>
        (
          globalThis as unknown as { coalHitEvents: boolean[] }
        ).coalHitEvents.at(-1),
      ),
    )
    .toBe(false);
  checks.push("alpha-hit-test-switches-native-click-through");
  await pet.evaluate(() =>
    (
      window as unknown as { coalDesktop: { openChat: () => void } }
    ).coalDesktop.openChat(),
  );
  await expect
    .poll(() =>
      native!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith("/pet/chat"))!
          .isVisible(),
      ),
    )
    .toBe(true);
  await expect(chat.locator("#connection")).toContainText("在呢");
  for (const [id, button] of [
    ["fruit", "喂果子"],
    ["heart", "比心"],
    ["sign", "举牌"],
    ["cake", "背蛋糕"],
  ] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(pet.locator("#coal")).toHaveAttribute("data-action", id, {
      timeout: 5000,
    });
  }
  checks.push("four-requested-animations-from-separate-browser");
  // Native renderer receives the same narrowly-scoped controls as the tray menu.
  await native.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith("/pet"))!
      .webContents.send("coal:control", { type: "paused", value: true }),
  );
  const paused = await pet.locator("#coal").getAttribute("data-frame");
  await pet.waitForTimeout(350);
  expect(await pet.locator("#coal").getAttribute("data-frame")).toBe(paused);
  await native.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith("/pet"))!
      .webContents.send("coal:control", { type: "paused", value: false }),
  );
  checks.push("native-pause-resume");
  // Wait for the explicit user action's four-second lifetime before Codex takes over.
  await expect(pet.locator("#coal")).toHaveAttribute("data-action", "idle", {
    timeout: 6000,
  });
  await hook("UserPromptSubmit");
  await hook("PreToolUse", "edit-1");
  await expect(
    chat.locator('#codex-session option[value="desktop-smoke-session"]'),
  ).toHaveCount(1, { timeout: 6000 });
  await chat.locator("#codex-session").selectOption("desktop-smoke-session");
  await expect(pet.locator("#coal")).toHaveAttribute("data-action", "code", {
    timeout: 6000,
  });
  checks.push("real-hook-process-to-native-coding-animation");
  await hook("PermissionRequest", "edit-1");
  await expect(pet.locator("#bubble")).toContainText("需要你", {
    timeout: 6000,
  });
  await hook("PostToolUse", "edit-1");
  await hook("Stop");
  await expect(pet.locator("#coal")).toHaveAttribute("data-action", "happy", {
    timeout: 6000,
  });
  await expect(pet.locator("#coal")).toHaveAttribute("data-action", "idle", {
    timeout: 6000,
  });
  expect(JSON.stringify(runtime.bridge.state.snapshot())).not.toContain(
    "Must never be forwarded",
  );
  checks.push("approval-stop-and-no-source-forwarding");
  await chat.screenshot({ path: join(output, "native-chat.png") });
  await pet.screenshot({
    path: join(output, "native-pet.png"),
    omitBackground: true,
  });
  await native.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith("/pet/chat"))!
      .close(),
  );
  await expect
    .poll(() =>
      native!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith("/pet"))!
          .isVisible(),
      ),
    )
    .toBe(true);
  checks.push("closing-chat-keeps-pet");
  expect(errors).toEqual([]);
  const report = {
    passed: true,
    mode: "mock-model-real-electron-and-hook-process",
    checks,
    browserErrors: errors,
  };
  writeFileSync(
    join(output, "desktop-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await native?.close();
  await browser.close();
  await runtime.close();
  rmSync(dir, { recursive: true, force: true });
}
