import { PetClient, errorText, codexLabel } from "./client.js";
import { CoalSprite } from "./sprite.js";
import { ReplyAudio } from "./audio.js";

const $ = (id) => document.getElementById(id),
  client = new PetClient();
const channel = new BroadcastChannel("coal-pet-controls"),
  desktop = window.coalDesktop;
const avatar = new CoalSprite($("avatar"));
const player = new ReplyAudio(client);
let sending = false,
  pending = null,
  fingerprint = "",
  initialized = false;
const draftKey = "coal-chat-draft-v1";
try {
  const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
  if (typeof saved?.text === "string")
    $("draft").value = saved.text.slice(0, 4000);
  if (typeof saved?.key === "string" && saved.text.trim())
    pending = { text: saved.text.trim(), key: saved.key };
} catch {}
function saveDraft() {
  try {
    if ($("draft").value)
      localStorage.setItem(
        draftKey,
        JSON.stringify({
          text: $("draft").value,
          ...(pending?.text === $("draft").value.trim()
            ? { key: pending.key }
            : {}),
        }),
      );
    else localStorage.removeItem(draftKey);
  } catch {}
}
$("draft").addEventListener("input", saveDraft);
function error(value) {
  $("error").textContent = value;
  $("error").hidden = !value;
}
async function sendControl(command) {
  const value = { ...command, nonce: crypto.randomUUID() };
  channel.postMessage({
    type: "control",
    command: { ...value, issuedAt: Date.now() },
  });
  try {
    await client.request("/v1/pet/control", "POST", value);
  } catch (e) {
    error(errorText(e));
  }
}
function stopAudio() {
  player.stop();
  $("voice-stop").disabled = true;
}
async function speak(message) {
  channel.postMessage({ type: "stop-audio" });
  $("voice-stop").disabled = false;
  try {
    await player.play(message);
  } catch (e) {
    if (e.name !== "AbortError") error(errorText(e));
  } finally {
    $("voice-stop").disabled = true;
  }
}
player.addEventListener("playing", () => avatar.play("talk"));
player.addEventListener("stopped", () =>
  avatar.play(client.activeRun() ? "think" : "idle"),
);
function renderMessages(snapshot) {
  const visible = snapshot.messages.filter(
    (m) => m.role === "user" || m.status === "completed",
  );
  const next = JSON.stringify(
    visible.map((m) => [m.id, m.revision, m.status, m.content]),
  );
  if (fingerprint === next) return;
  fingerprint = next;
  const nearBottom =
    $("messages").scrollHeight -
      $("messages").scrollTop -
      $("messages").clientHeight <
    100;
  $("messages").replaceChildren();
  if (!visible.length) {
    const p = document.createElement("p");
    p.className = "empty";
    const title = document.createElement("strong"),
      caption = document.createElement("span");
    title.textContent = "代码写累了，就来找我。";
    caption.textContent = "聊聊今天，或者一起发一会儿呆。";
    p.append(title, caption);
    $("messages").append(p);
  }
  for (const m of visible) {
    const article = document.createElement("article");
    article.className = `message ${m.role}`;
    article.dataset.messageId = m.id;
    const who = document.createElement("small");
    who.textContent = m.role === "user" ? "你" : "煤球";
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = m.content;
    article.append(who, text);
    if (m.role === "assistant" && m.status === "completed" && m.content) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "朗读";
      b.className = "speak";
      b.addEventListener("click", () => void speak(m));
      article.append(b);
    }
    $("messages").append(article);
  }
  if (nearBottom) $("messages").scrollTop = $("messages").scrollHeight;
}
function render() {
  const s = client.snapshot;
  $("connection").textContent = client.connected
    ? "在呢，想说什么都可以慢慢说。"
    : "连接中断，正在恢复；不会重复发送消息。";
  $("codex-label").textContent = codexLabel(client.codex);
  const options = client.codex?.sessions ?? [],
    selected = client.codex?.boundSessionId ?? "";
  const signature = JSON.stringify([selected, options.map((o) => o.sessionId)]);
  if ($("codex-session").dataset.signature !== signature) {
    $("codex-session").dataset.signature = signature;
    $("codex-session").replaceChildren(new Option("暂不跟随", ""));
    for (const item of options)
      $("codex-session").add(
        new Option(
          `会话 ${item.sessionId.slice(0, 8)} · ${new Date(item.updatedAt).toLocaleTimeString("zh-CN")}`,
          item.sessionId,
        ),
      );
    $("codex-session").value = selected;
  }
  if (!s) return;
  if (!initialized) {
    initialized = true;
    if (!client.setup?.ready) {
      if (desktop) desktop.openSetup();
      else location.replace("/pet/setup");
    }
  }
  $("focus").checked = s.settings.focused;
  $("voice-enabled").checked = client.preferences.voiceEnabled;
  $("auto-speak").checked = client.preferences.autoSpeak;
  $("voice-record").disabled = !client.preferences.voiceEnabled;
  $("send").disabled =
    sending ||
    !client.connected ||
    !client.setup?.ready ||
    !s.settings.remoteDisclosureAcknowledged ||
    !s.model.configured;
  $("cancel-run").hidden = !client.activeRun();
  $("run-status").textContent = client.activeRun()
    ? window.companionRunStatus(client.activeRun(), "煤球", Date.now())
    : "";
  if (!player.message) avatar.play(client.activeRun() ? "think" : "idle");
  if (
    player.message &&
    (player.message.epoch !== s.settings.epoch ||
      !s.messages.some(
        (m) =>
          m.id === player.message.id && m.revision === player.message.revision,
      ))
  )
    stopAudio();
  renderMessages(s);
}
client.addEventListener("change", render);
client.addEventListener("privacy-reset", () => {
  stopAudio();
  pending = null;
  $("draft").value = "";
  saveDraft();
  fingerprint = "";
  $("messages").replaceChildren();
});
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("draft").value.trim();
  if (!text || sending || $("send").disabled) return;
  sending = true;
  error("");
  stopAudio();
  if (!pending || pending.text !== text)
    pending = { text, key: crypto.randomUUID() };
  saveDraft();
  render();
  try {
    await client.submit(text, pending.key);
    if ($("draft").value.trim() === text) $("draft").value = "";
    pending = null;
    saveDraft();
    await client.refresh();
  } catch (e) {
    error(errorText(e));
    void client.refresh().catch(() => {});
  } finally {
    sending = false;
    render();
  }
});
$("draft").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("cancel-run").addEventListener("click", async () => {
  const run = client.activeRun();
  if (!run) return;
  stopAudio();
  try {
    await client.request(
      `/v1/runs/${encodeURIComponent(run.id)}/cancel`,
      "POST",
      {},
    );
    await client.refresh();
  } catch (e) {
    error(errorText(e));
  }
});
$("focus").addEventListener("change", async () => {
  stopAudio();
  try {
    await client.settings({ focused: $("focus").checked });
  } catch (e) {
    error(errorText(e));
    render();
  }
});
$("pet-size").addEventListener(
  "change",
  () => void sendControl({ type: "size", value: Number($("pet-size").value) }),
);
document.querySelectorAll("[data-fun]").forEach((button) =>
  button.addEventListener("click", () => {
    void sendControl({ type: "action", id: button.dataset.fun });
    avatar.play(button.dataset.fun);
    setTimeout(() => avatar.play(client.activeRun() ? "think" : "idle"), 3500);
  }),
);
$("codex-session").addEventListener("change", async () => {
  try {
    client.codex = await client.request("/v1/pet/codex/bind", "POST", {
      sessionId: $("codex-session").value || null,
    });
    render();
  } catch (e) {
    error(errorText(e));
  }
});
$("edit-keys").addEventListener("click", () => {
  if (desktop) desktop.openSetup();
  else location.assign("/pet/setup");
});
$("window-close").addEventListener("click", () => desktop?.hideChat());
$("voice-record").addEventListener("click", () => {
  stopAudio();
  if (desktop) desktop.openVoice();
  else location.assign("/pet");
});
for (const [id, key] of [
  ["voice-enabled", "voiceEnabled"],
  ["auto-speak", "autoSpeak"],
])
  $(id).addEventListener("change", async () => {
    try {
      client.preferences = await client.request(
        "/v1/pet/preferences",
        "PATCH",
        { [key]: $(id).checked },
      );
      if (!client.preferences.voiceEnabled)
        channel.postMessage({ type: "stop-audio" });
      render();
    } catch (e) {
      error(errorText(e));
      render();
    }
  });
$("voice-stop").addEventListener("click", stopAudio);
channel.onmessage = ({ data }) => {
  if (data.type === "stop-audio") {
    stopAudio();
  }
};
if (desktop) {
  $("show-pet").hidden = false;
  $("show-pet").addEventListener("click", () => desktop.showPet());
}
const off = desktop?.onControl((data) => {
  if (data.type === "suspended" && data.value) {
    stopAudio();
  }
  if (data.type === "size") $("pet-size").value = String(data.value);
});
try {
  await avatar.ready();
  await client.start();

  const config = await fetch("/pet/config.json").then((r) => r.json());
  $("mode").textContent =
    config.mode === "mock"
      ? "当前为模拟回复验收模式。"
      : "当前连接真实聊天模型。";
  const preferences = await desktop?.preferences();
  if (preferences) $("pet-size").value = String(preferences.size);
} catch (e) {
  error(errorText(e));
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAudio();
  }
});
window.addEventListener("beforeunload", () => {
  off?.();
  stopAudio();
  client.close();
  avatar.close();
  channel.close();
});
