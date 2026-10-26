import { PetClient, codexLabel } from "./client.js";
import { CoalSprite } from "./sprite.js";

const canvas = document.getElementById("coal"),
  bubble = document.getElementById("bubble");
const desktop = window.coalDesktop;
const channel = new BroadcastChannel("coal-pet-controls");
const client = new PetClient();
const sprite = new CoalSprite(canvas);
let override = null,
  overrideTimer,
  talking = false,
  paused = false,
  sleep = false;
let pointer = null,
  interactive = false,
  lastPointer = null;
const attachedAt = Date.now();
const celebrated = new Set();
const seenControls = new Set();
function control(command, refresh = true) {
  if (
    !command ||
    seenControls.has(command.nonce) ||
    command.issuedAt < attachedAt ||
    Date.now() - command.issuedAt > 30_000
  )
    return;
  seenControls.add(command.nonce);
  if (seenControls.size > 128)
    seenControls.delete(seenControls.values().next().value);
  if (command.type === "action" && Date.now() - command.issuedAt < 5000)
    action(
      command.id,
      Math.max(500, 4000 - (Date.now() - command.issuedAt)),
      refresh,
    );
  if (command.type === "size") desktop?.setSize(command.value);
}
function openChat() {
  if (desktop) desktop.openChat();
  else location.href = "/pet/chat";
}
function show(text) {
  bubble.textContent = text;
  bubble.hidden = !text || client.snapshot?.settings.focused;
}
function render() {
  for (const command of client.codex?.controls ?? []) control(command, false);
  const focused = client.snapshot?.settings.focused;
  const run = client.activeRun();
  const coding =
    client.codex?.connection === "following" ? client.codex.selected : null;
  if (talking) sprite.play("talk");
  else if (run) sprite.play("think");
  else if (override) sprite.play(override);
  else if (coding?.phase === "attention") sprite.play("wave");
  else if (coding?.phase === "coding") sprite.play("code");
  else if (coding?.phase === "thinking") sprite.play("think");
  else sprite.play(sleep ? "sleep" : "idle");
  if (!client.connected) show("正在连接煤球…");
  else if (run) show("让我想一想，唔…");
  else if (coding?.phase === "attention") show("Codex需要你看一下。 ");
  else if (coding?.phase === "coding") show("陪你一起敲敲小键盘。 ");
  else show(override === "sign" ? "飞飞爱你" : "");
  const key = coding?.completedAt
    ? `${coding.sessionId}/${coding.turnId}/${coding.completedAt}`
    : null;
  if (key && !celebrated.has(key)) {
    celebrated.add(key);
    if (
      !focused &&
      coding.completedAt >= attachedAt &&
      Date.now() - coding.completedAt < 5000
    )
      action("happy", 1200);
  }
  canvas.dataset.connected = String(client.connected);
  canvas.dataset.codex = codexLabel(client.codex);
}
function action(id, duration = 4000, refresh = true) {
  override = id;
  clearTimeout(overrideTimer);
  overrideTimer = setTimeout(() => {
    override = null;
    render();
  }, duration);
  if (refresh) render();
}
function mouseMode(hit) {
  if (interactive === hit) return;
  interactive = hit;
  desktop?.setInteractive(hit);
}
function hit(event) {
  return (
    (!bubble.hidden && event.target === bubble) ||
    sprite.hit(event.clientX, event.clientY)
  );
}
window.addEventListener("pointermove", (event) => {
  lastPointer = {
    clientX: event.clientX,
    clientY: event.clientY,
    target: event.target,
  };
  if (pointer) {
    if (
      !pointer.moved &&
      Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) > 4
    ) {
      pointer.moved = true;
      desktop?.beginDrag();
    }
    if (pointer.moved) desktop?.drag();
    return;
  }
  mouseMode(hit(event));
});
// Electron forwards mouse-move events while the transparent window is ignored.
window.addEventListener("mousemove", (event) => {
  if (!pointer) {
    lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.target,
    };
    mouseMode(hit(event));
  }
});
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !sprite.hit(event.clientX, event.clientY)) return;
  pointer = { x: event.screenX, y: event.screenY, moved: false };
  canvas.setPointerCapture(event.pointerId);
  mouseMode(true);
});
canvas.addEventListener("pointerup", (event) => {
  if (!pointer) return;
  const moved = pointer.moved;
  pointer = null;
  desktop?.endDrag();
  if (canvas.hasPointerCapture(event.pointerId))
    canvas.releasePointerCapture(event.pointerId);
  if (!moved) openChat();
});
canvas.addEventListener("lostpointercapture", () => {
  pointer = null;
  desktop?.endDrag();
});
window.addEventListener("mouseleave", () => {
  if (!pointer) mouseMode(false);
});
canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (sprite.hit(event.clientX, event.clientY)) desktop?.menu();
});
canvas.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") openChat();
});
bubble.addEventListener("click", openChat);
sprite.addEventListener("frame", () => {
  if (lastPointer && !pointer) mouseMode(hit(lastPointer));
});
sprite.addEventListener("complete", () => {
  if (override === "happy" || override === "wave") {
    override = null;
    queueMicrotask(render);
  }
});
client.addEventListener("change", render);
channel.onmessage = ({ data }) => {
  if (data.type === "control") control(data.command);
  if (
    data.type === "action" &&
    ["fruit", "heart", "sign", "cake", "wave"].includes(data.id)
  )
    action(data.id);
  if (data.type === "audio") {
    talking = data.playing === true;
    render();
  }
};
const off = desktop?.onControl((data) => {
  if (data.type === "action") action(data.id);
  if (data.type === "paused") {
    paused = data.value;
    sprite.pause(paused);
  }
  if (data.type === "sleep") {
    sleep = data.value;
    render();
  }
  if (data.type === "size")
    document.documentElement.style.setProperty("--pet-size", `${data.value}px`);
  if (data.type === "suspended") {
    talking = false;
    sprite.pause(data.value || paused);
    channel.postMessage({ type: "stop-audio" });
  }
});
try {
  await sprite.ready();
  const prefs = await desktop?.preferences();
  if (prefs)
    document.documentElement.style.setProperty("--pet-size", `${prefs.size}px`);
  void client.start();
} catch {
  show("煤球的图片没有载入，请重启试试。 ");
}
window.addEventListener("beforeunload", () => {
  off?.();
  clearTimeout(overrideTimer);
  client.close();
  sprite.close();
  channel.close();
});
