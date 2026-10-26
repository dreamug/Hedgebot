import { PetClient, codexLabel } from "./client.js";
import { CoalSprite } from "./sprite.js";
import { ReplyAudio } from "./audio.js";
import { VoiceConversation, voiceError } from "./voice.js";
const $ = (id) => document.getElementById(id),
  canvas = $("coal"),
  bubble = $("bubble"),
  desktop = window.coalDesktop;
const channel = new BroadcastChannel("coal-pet-controls"),
  client = new PetClient(),
  sprite = new CoalSprite(canvas),
  player = new ReplyAudio(client);
const voice = new VoiceConversation(client, player, {
  onSetup: () =>
    desktop ? desktop.openSetup() : location.assign("/pet/setup"),
  permission: async () => (desktop ? desktop.microphone() : true),
});
let override = null,
  overrideTimer,
  paused = false,
  sleep = false,
  pointer = null,
  interactive = false,
  lastPointer = null,
  clickTimer = null,
  panelTimer = null,
  audioPlaying = false;
const attachedAt = Date.now(),
  celebrated = new Set(),
  seenControls = new Set(),
  spoken = new Set();
function openChat() {
  voice.cancel();
  setPanel(false);
  clearTimeout(clickTimer);
  clickTimer = null;
  if (desktop) desktop.openChat();
  else location.href = "/pet/chat";
}
function show(text) {
  bubble.textContent = text;
  bubble.hidden =
    !text || client.snapshot?.settings.focused || !$("voice-panel").hidden;
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
function control(command, refresh = true) {
  if (
    !command ||
    seenControls.has(command.nonce) ||
    command.issuedAt < attachedAt ||
    Date.now() - command.issuedAt > 30000
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
function render() {
  for (const command of client.codex?.controls ?? []) control(command, false);
  if (!client.preferences.voiceEnabled && voice.state !== "idle")
    voice.cancel();
  const focused = client.snapshot?.settings.focused,
    run = client.activeRun(),
    coding =
      client.codex?.connection === "following" ? client.codex.selected : null;
  if (audioPlaying || voice.state === "speaking") sprite.play("talk");
  else if (["waiting", "replying", "transcribing"].includes(voice.state) || run)
    sprite.play("think");
  else if (voice.state === "listening") sprite.play("idle");
  else if (override) sprite.play(override);
  else if (coding?.phase === "attention") sprite.play("wave");
  else if (coding?.phase === "coding") sprite.play("code");
  else if (coding?.phase === "thinking") sprite.play("think");
  else sprite.play(sleep ? "sleep" : "idle");
  if (!client.connected) show("正在连上你的小刺猬…");
  else if (!client.setup?.ready) show("先帮我接上脑袋和声音吧。");
  else if (run) show("让我想一想，唔…");
  else if (coding?.phase === "attention") show("Codex需要你看一下。");
  else if (coding?.phase === "coding") show("陪你敲敲小键盘。");
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
  for (const message of client.snapshot?.messages ?? []) {
    if (
      message.role !== "assistant" ||
      message.status !== "completed" ||
      message.createdAt < attachedAt ||
      spoken.has(message.id) ||
      voice.owned.has(message.runId)
    )
      continue;
    const r = client.snapshot.runs.find((value) => value.id === message.runId);
    if (r?.status !== "completed") continue;
    spoken.add(message.id);
    if (spoken.size > 128) spoken.delete(spoken.values().next().value);
    if (
      client.preferences.autoSpeak &&
      client.preferences.voiceEnabled &&
      voice.state === "idle" &&
      !player.message
    ) {
      $("voice-text").textContent = message.content;
      $("voice-state").textContent = "煤球想和你说";
      setPanel(true);
      void player
        .play(message)
        .catch((error) => {
          if (error.name !== "AbortError") {
            $("voice-state").textContent = "文字已经留在聊天里";
            $("voice-text").textContent = voiceError(error);
          }
        })
        .finally(() => schedulePanelClose());
    }
  }
  canvas.dataset.connected = String(client.connected);
  canvas.dataset.codex = codexLabel(client.codex);
  canvas.dataset.voice = voice.state;
}
function setPanel(visible) {
  clearTimeout(panelTimer);
  $("voice-panel").hidden = !visible;
  desktop?.voicePanel(visible);
  if (visible) bubble.hidden = true;
}
function schedulePanelClose() {
  clearTimeout(panelTimer);
}
function voiceUI() {
  const state = voice.state;
  canvas.dataset.voice = state;
  document.body.dataset.voice = state;
  $("voice-state").textContent = {
    idle: "煤球在这里",
    permission: "正在接通",
    listening: "正在听写",
    transcribing: "确认你的话",
    waiting: "让我想一想",
    replying: "有话想对你说",
    speaking: "煤球在说",
    error: "再试一次就好",
  }[state];
  $("voice-caption").textContent =
    state === "listening"
      ? "松开发送 · 文字会随你说话更新"
      : state === "transcribing"
        ? "正在确认最后几个字，还没有发送"
        : state === "waiting"
          ? "已发送给煤球"
          : state === "error"
            ? "这次录音已结束"
            : "按住说话，松开发送。双击煤球也可以打字。";
  $("voice-text").textContent = voice.detail || "今天想和我聊点什么？";
  $("voice-heard").hidden =
    !voice.transcript ||
    ["idle", "permission", "listening", "transcribing", "error"].includes(
      state,
    );
  $("voice-heard").textContent = voice.transcript
    ? `你说：${voice.transcript}`
    : "";
  $("voice-hold").textContent =
    state === "listening"
      ? "松开发送"
      : state === "permission"
        ? "准备中…"
        : "按住说话";
  $("voice-bars").hidden = state !== "listening";
  if (state !== "idle") setPanel(true);
  render();
}
voice.addEventListener("change", voiceUI);
voice.addEventListener("level", () => {
  [...$("voice-bars").children].forEach(
    (bar, i) => (bar.style.height = `${5 + voice.level * (i % 2 ? 23 : 16)}px`),
  );
});
player.addEventListener("playing", () => {
  audioPlaying = true;
  render();
});
player.addEventListener("stopped", () => {
  audioPlaying = false;
  render();
});
let heldPointer = null,
  heldKey = false;
const hold = $("voice-hold");
hold.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || heldPointer !== null) return;
  event.preventDefault();
  heldPointer = event.pointerId;
  hold.setPointerCapture(event.pointerId);
  void voice.start();
});
hold.addEventListener("pointerup", (event) => {
  if (heldPointer !== event.pointerId) return;
  heldPointer = null;
  voice.finish();
  if (hold.hasPointerCapture(event.pointerId))
    hold.releasePointerCapture(event.pointerId);
});
for (const type of ["pointercancel", "lostpointercapture"])
  hold.addEventListener(type, () => {
    if (heldPointer !== null) {
      heldPointer = null;
      voice.cancel();
    }
  });
hold.addEventListener("keydown", (event) => {
  if (![" ", "Enter"].includes(event.key) || event.repeat) return;
  event.preventDefault();
  heldKey = true;
  void voice.start();
});
hold.addEventListener("keyup", (event) => {
  if (![" ", "Enter"].includes(event.key) || !heldKey) return;
  event.preventDefault();
  heldKey = false;
  voice.finish();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    heldKey = false;
    heldPointer = null;
    voice.cancel();
    setPanel(false);
  }
});
window.addEventListener("blur", () => {
  if (heldKey || heldPointer !== null) {
    heldKey = false;
    heldPointer = null;
    voice.cancel();
  }
});
$("voice-cancel").addEventListener("click", () => {
  voice.cancel();
  setPanel(false);
});
$("voice-text-chat").addEventListener("click", openChat);
function singleClick() {
  clickTimer = null;
  if (!client.setup?.ready) {
    if (desktop) desktop.openSetup();
    else location.assign("/pet/setup");
    return;
  }
  setPanel(true);
  voiceUI();
}
function clickPet() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    openChat();
  } else clickTimer = setTimeout(singleClick, 500);
}
function mouseMode(hit) {
  if (interactive === hit) return;
  interactive = hit;
  desktop?.setInteractive(hit);
}
function hit(event) {
  return (
    Boolean(event.target?.closest?.("#voice-panel")) ||
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
      clearTimeout(clickTimer);
      clickTimer = null;
      desktop?.beginDrag();
    }
    if (pointer.moved) desktop?.drag();
    return;
  }
  mouseMode(hit(event));
});
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
  if (!moved) clickPet();
});
canvas.addEventListener("dblclick", (event) => event.preventDefault());
canvas.addEventListener("lostpointercapture", () => {
  pointer = null;
  desktop?.endDrag();
});
window.addEventListener("mouseleave", () => {
  if (!pointer) mouseMode(false);
});
canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  clearTimeout(clickTimer);
  clickTimer = null;
  if (sprite.hit(event.clientX, event.clientY)) desktop?.menu();
});
canvas.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (event.shiftKey) openChat();
    else singleClick();
  }
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
client.addEventListener("privacy-reset", () => {
  voice.cancel();
  player.stop();
  setPanel(false);
});
channel.onmessage = ({ data }) => {
  if (data.type === "control") control(data.command);
  if (data.type === "stop-audio") voice.cancel();
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
  if (data.type === "voice-start") singleClick();
  if (data.type === "suspended") {
    voice.cancel();
    player.stop();
    sprite.pause(data.value || paused);
  }
});
try {
  await sprite.ready();
  const prefs = await desktop?.preferences();
  if (prefs)
    document.documentElement.style.setProperty("--pet-size", `${prefs.size}px`);
  await client.start();
} catch {
  show("图片没加载好，重新打开煤球试试。");
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    heldKey = false;
    heldPointer = null;
    voice.cancel();
    player.stop();
  }
});
window.addEventListener("beforeunload", () => {
  off?.();
  clearTimeout(overrideTimer);
  clearTimeout(clickTimer);
  clearTimeout(panelTimer);
  voice.close();
  player.stop();
  client.close();
  sprite.close();
  channel.close();
});
