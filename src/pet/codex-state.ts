import { realpathSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import { z } from "zod";

export const HookEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200).optional(),
    event: z.enum([
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "Stop",
      "Interrupt",
    ]),
    toolId: z.string().min(1).max(200).optional(),
    toolKind: z.enum(["file-edit", "other"]).optional(),
    cwd: z.string().min(1).max(4000),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type HookEvent = z.infer<typeof HookEventSchema>;
type Phase = "idle" | "thinking" | "coding" | "attention" | "ended";
type Session = {
  id: string;
  turnId?: string;
  phase: Phase;
  updatedAt: number;
  completedAt?: number;
  endedTurn: boolean;
  tools: Map<string, string>;
  retired: Set<string>;
  waiting: Set<string>;
};

/** Ephemeral UI projection, scoped to one project. Never becomes model memory. */
export class CodexPetState {
  private readonly root: string;
  private sessions = new Map<string, Session>();
  private seen = new Set<string>();
  private binding: string | null = null;
  constructor(
    projectRoot: string,
    private now: () => number = Date.now,
  ) {
    this.root = realpathSync(projectRoot);
  }
  ingest(input: unknown) {
    const e = HookEventSchema.parse(input);
    const diff = relative(this.root, realpathSync(e.cwd));
    if (diff === ".." || diff.startsWith(`..${sep}`) || isAbsolute(diff))
      return { accepted: false, reason: "other_project" };
    if (Math.abs(this.now() - e.at) > 30_000)
      return { accepted: false, reason: "stale_event" };
    if (this.seen.has(e.eventId))
      return { accepted: false, reason: "duplicate" };
    this.seen.add(e.eventId);
    if (this.seen.size > 2048)
      this.seen.delete(this.seen.values().next().value!);
    let s = this.sessions.get(e.sessionId);
    if (!s) {
      if (this.sessions.size >= 24) {
        const removable = [...this.sessions.values()]
          .filter((v) => v.id !== this.binding)
          .sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (removable) this.sessions.delete(removable.id);
      }
      s = {
        id: e.sessionId,
        phase: "idle",
        updatedAt: e.at,
        tools: new Map(),
        retired: new Set(),
        waiting: new Set(),
        endedTurn: false,
      };
      this.sessions.set(s.id, s);
    }
    if (e.at < s.updatedAt || (e.turnId && s.retired.has(e.turnId)))
      return { accepted: false, reason: "old_turn" };
    if (e.event === "UserPromptSubmit") {
      if (s.turnId && s.turnId !== e.turnId) s.retired.add(s.turnId);
      if (s.retired.size > 128)
        s.retired.delete(s.retired.values().next().value!);
      if (s.turnId === e.turnId && s.endedTurn)
        return { accepted: false, reason: "ended_turn" };
      s.turnId = e.turnId;
      s.endedTurn = false;
      s.tools.clear();
      s.waiting.clear();
      s.phase = "thinking";
      delete s.completedAt;
    } else if (e.event === "SessionStart") {
      // A late startup event cannot erase an in-flight turn.
      if (!s.turnId) s.phase = "idle";
    } else if (e.event === "SessionEnd") {
      s.phase = "ended";
      s.endedTurn = true;
      s.tools.clear();
      s.waiting.clear();
    } else {
      if (s.turnId && e.turnId && s.turnId !== e.turnId)
        return { accepted: false, reason: "different_turn" };
      if (s.endedTurn) return { accepted: false, reason: "ended_turn" };
      s.turnId ??= e.turnId;
      if (e.event === "PreToolUse") {
        if (e.toolId && s.tools.size < 128)
          s.tools.set(e.toolId, e.toolKind ?? "other");
        if (e.toolId) s.waiting.delete(e.toolId);
        s.phase = s.waiting.size
          ? "attention"
          : [...s.tools.values()].includes("file-edit")
            ? "coding"
            : "thinking";
      } else if (e.event === "PermissionRequest") {
        // Current Codex PermissionRequest hooks may omit tool_use_id.
        // Conservatively keep all matching in-flight tools pending in that case.
        const candidates = e.toolId
          ? [e.toolId]
          : [...s.tools]
              .filter(([, kind]) => kind === e.toolKind)
              .map(([id]) => id);
        for (const id of candidates.length ? candidates : ["$unknown"])
          s.waiting.add(id);
        s.phase = "attention";
      } else if (e.event === "PostToolUse") {
        if (e.toolId) {
          s.tools.delete(e.toolId);
          s.waiting.delete(e.toolId);
        }
        s.phase = s.waiting.size
          ? "attention"
          : [...s.tools.values()].includes("file-edit")
            ? "coding"
            : "thinking";
      } else {
        s.tools.clear();
        s.waiting.clear();
        s.endedTurn = true;
        s.phase = "idle";
        if (e.event === "Stop") s.completedAt = e.at;
      }
    }
    s.updatedAt = e.at;
    return { accepted: true };
  }
  bind(id: string | null) {
    if (id !== null && !this.sessions.has(id)) return false;
    this.binding = id;
    return true;
  }
  snapshot() {
    const list = [...this.sessions.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const selected = this.binding ? this.sessions.get(this.binding) : undefined;
    const project = (s: Session) => ({
      sessionId: s.id,
      turnId: s.turnId,
      phase: s.phase,
      updatedAt: s.updatedAt,
      completedAt: s.completedAt,
      activeTools: s.tools.size,
    });
    return {
      schemaVersion: 1,
      connection: !this.binding
        ? list.length
          ? "unbound"
          : "waiting"
        : selected && this.now() - selected.updatedAt <= 60_000
          ? "following"
          : "stale",
      boundSessionId: this.binding,
      selected: selected ? project(selected) : null,
      sessions: list.map(project),
    };
  }
}
