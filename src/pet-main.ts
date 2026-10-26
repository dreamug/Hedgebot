import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { stableMemoryConfig } from "./memory/stable-config.js";
import { createPetRuntime } from "./pet/runtime.js";

let runtime: Awaited<ReturnType<typeof createPetRuntime>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime?.close();
}
try {
  const config = stableMemoryConfig(
    loadConfig({
      dataDir: resolve(process.env.PET_DATA_DIR ?? "local-data/hedgehog-app"),
      port: Number(process.env.PET_PORT ?? 4348),
    }),
  );
  runtime = await createPetRuntime(
    config,
    resolve(process.env.PET_PROJECT_ROOT ?? "."),
    Number(process.env.PET_BRIDGE_PORT ?? 4349),
  );
  console.log(`煤球已启动：${runtime.address}/pet/chat`);
  process.send?.({ type: "pet-ready", address: runtime.address });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void stop().then(() => process.exit(0)));
  process.once("disconnect", () => void stop().then(() => process.exit(0)));
} catch {
  await stop();
  console.error("煤球启动失败，请检查端口、数据目录或是否已有实例。");
  process.exitCode = 1;
}
