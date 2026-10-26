import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(
  resolve(fileURLToPath(new URL("../..", import.meta.url))),
);
const dir = join(root, ".codex");
const path = join(dir, "hooks.json");
const dataDir = resolve(
  process.env.PET_DATA_DIR ?? join(root, "local-data/hedgehog-app"),
);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
// Windows hooks use an encoded PowerShell command: paths with spaces, apostrophes,
// percent signs and non-ASCII characters never become shell syntax.
const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'";
const ps = `& ${psQuote(process.execPath)} ${psQuote(join(root, "scripts/hedgehog/codex-hook.mjs"))} --config ${psQuote(join(dataDir, "codex-bridge.json"))}`;
const commandWindows = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`;
const command = `${quote(process.execPath)} ${quote(join(root, "scripts/hedgehog/codex-hook.mjs"))} --config ${quote(join(dataDir, "codex-bridge.json"))}`;
const events = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
];
const document = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
document.hooks ??= {};
// Preserve unrelated hooks. Only replace this observer's own managed entry.
for (const event of events) {
  const groups = document.hooks[event] ?? [];
  if (!Array.isArray(groups))
    throw new Error(`Existing ${event} hooks are not an array`);
  document.hooks[event] = groups
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter(
        (handler) =>
          !(
            handler.type === "command" &&
            handler.statusMessage === "煤球：同步工作状态" &&
            (String(handler.command).includes(
              "scripts/hedgehog/codex-hook.mjs",
            ) ||
              String(handler.command).includes(
                "scripts\\hedgehog\\codex-hook.mjs",
              ))
          ),
      ),
    }))
    .filter((group) => group.hooks.length);
  if (!process.argv.includes("--remove"))
    document.hooks[event].push({
      hooks: [
        {
          type: "command",
          command,
          commandWindows,
          timeout: 3,
          statusMessage: "煤球：同步工作状态",
        },
      ],
    });
}
mkdirSync(dir, { recursive: true });
if (existsSync(path) && !existsSync(`${path}.before-hedgehog`))
  writeFileSync(`${path}.before-hedgehog`, readFileSync(path), { mode: 0o600 });
const temporary = `${path}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", {
  mode: 0o600,
});
const { renameSync } = await import("node:fs");
renameSync(temporary, path);
console.log(
  process.argv.includes("--remove")
    ? "煤球 hooks 已移除，其他 hooks 保留。"
    : "煤球 hooks 已配置。请在 Codex 的 /hooks 中审核并信任，然后在煤球聊天窗选择要跟随的会话。",
);
