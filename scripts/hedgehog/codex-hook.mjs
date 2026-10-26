import { readFileSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

// Fail open: this observer never approves, rejects, continues, or logs a turn.
const supported = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
]);
async function run() {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1]) return;
  const path = process.argv[index + 1];
  const stat = statSync(path);
  if (
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    return;
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (
    !/^http:\/\/127\.0\.0\.1:\d+\/events$/.test(config.address) ||
    !/^[a-f0-9]{64}$/.test(config.token)
  )
    return;
  let bytes = 0;
  const parts = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) return;
    parts.push(chunk);
  }
  const raw = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (
    !supported.has(raw.hook_event_name) ||
    typeof raw.session_id !== "string" ||
    typeof raw.cwd !== "string"
  )
    return;
  const event = raw.hook_event_name;
  const turnId = typeof raw.turn_id === "string" ? raw.turn_id : undefined;
  if (!["SessionStart", "SessionEnd"].includes(event) && !turnId) return;
  const toolId =
    typeof raw.tool_use_id === "string" ? raw.tool_use_id : undefined;
  const payload = {
    schemaVersion: 1,
    eventId: createHash("sha256")
      .update(JSON.stringify([raw.session_id, turnId, event, toolId]))
      .digest("hex"),
    sessionId: raw.session_id,
    ...(turnId ? { turnId } : {}),
    ...(toolId ? { toolId } : {}),
    event,
    toolKind: /^(?:apply_patch|Edit|Write)$/.test(raw.tool_name ?? "")
      ? "file-edit"
      : "other",
    cwd: realpathSync(raw.cwd),
    at: Date.now(),
  };
  // Only the explicit metadata above crosses the boundary; raw tool input and
  // transcript paths are never read or serialized.
  await fetch(config.address, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(250),
  });
}
run()
  .catch(() => {})
  .finally(() => {
    process.stdout.write("{}\n");
    process.exit(0);
  });
