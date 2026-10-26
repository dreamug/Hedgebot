import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mock = process.argv.includes("--mock");
const dataDir = resolve(
  process.env.PET_DATA_DIR ??
    join(root, mock ? "local-data/hedgehog-mock" : "local-data/hedgehog-app"),
);
let owned = null,
  desktop = null,
  stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  desktop?.kill("SIGTERM");
  if (owned && owned.exitCode === null) {
    owned.kill("SIGTERM");
    const limit = setTimeout(() => owned?.kill("SIGKILL"), 5000);
    limit.unref();
    await new Promise((done) => owned.once("exit", done));
    clearTimeout(limit);
  }
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void stop());
async function existing() {
  try {
    const lock = JSON.parse(readFileSync(join(dataDir, "daemon.lock"), "utf8"));
    if (lock.kind !== "hedgehog-desktop-v1" || !Number.isSafeInteger(lock.pid))
      return null;
    process.kill(lock.pid, 0);
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(lock.address)) return null;
    const response = await fetch(`${lock.address}/pet/config.json`, {
      signal: AbortSignal.timeout(1000),
    });
    const config = await response.json();
    if (
      config.kind !== "hedgehog-desktop-v1" ||
      (mock && config.mode !== "mock") ||
      (!mock && config.mode === "mock")
    )
      throw new Error("mode_mismatch");
    return lock.address;
  } catch (error) {
    if (error.message === "mode_mismatch") throw error;
    return null;
  }
}
try {
  let address = await existing();
  if (!address) {
    const env = {
      ...process.env,
      PET_DATA_DIR: dataDir,
      PET_PROJECT_ROOT: root,
      ...(mock ? { HARNESS_MODEL: "mock" } : {}),
    };
    owned = spawn(
      process.execPath,
      [
        join(root, "node_modules/tsx/dist/cli.mjs"),
        join(root, "src/pet-main.ts"),
      ],
      { cwd: root, env, stdio: ["ignore", "inherit", "inherit", "ipc"] },
    );
    address = await new Promise((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("backend_timeout")),
        15000,
      );
      owned.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      owned.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("backend_stopped"));
      });
      owned.on("message", (message) => {
        if (message.type === "pet-ready") {
          clearTimeout(timeout);
          done(message.address);
        }
      });
    });
  }
  const env = {
    ...process.env,
    PET_DATA_DIR: dataDir,
    PET_BACKEND_URL: address,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  desktop = spawn(electron, [join(root, "desktop/main.cjs")], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  desktop.once("exit", (code) => void stop(code ?? 1));
  desktop.once("error", () => void stop(1));
  owned?.once("exit", () => {
    if (!stopping) void stop(1);
  });
} catch {
  console.error("煤球未能启动，请检查4348/4349端口或数据目录。");
  await stop(1);
}
