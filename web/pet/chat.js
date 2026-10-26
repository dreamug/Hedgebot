import { PetClient, errorText, codexLabel } from "./client.js";
import { CoalSprite } from "./sprite.js";

const $ = (id) => document.getElementById(id),
  client = new PetClient();
const channel = new BroadcastChannel("coal-pet-controls"),
  desktop = window.coalDesktop;
const avatar = new CoalSprite($("avatar"));
let sending = false,
  pending = null,
  fingerprint = "",
  voice,
  audio = null,
  speechController = null,
  objectURL = null,
  speechSerial = 0,
  playingMessage = null,
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
  speechSerial++;
  speechController?.abort();
  speechController = null;
  if (audio) {
    audio.pause();
    audio.src = "";
    audio = null;
  }
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  playingMessage = null;
  $("voice-stop").disabled = true;
  channel.postMessage({ type: "audio", playing: false });
  avatar.play(client.activeRun() ? "think" : "idle");
}
async function speak(message) {
  stopAudio();
  const serial = speechSerial;
  playingMessage = {
    id: message.id,
    revision: message.revision,
    epoch: client.snapshot.settings.epoch,
  };
  const controller = new AbortController();
  speechController = controller;
  $("voice-stop").disabled = false;
  try {
    const response = await fetch("/v1/speech", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Bot-Id": "meiqiu",
        "X-Local-Token": client.boot.csrfToken,
      },
      body: JSON.stringify({
        kind: "message",
        id: message.id,
        expectedRevision: message.revision,
        expectedEpoch: playingMessage.epoch,
      }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error);
    }
    const blob = await response.blob();
    if (serial !== speechSerial || controller.signal.aborted) return;
    objectURL = URL.createObjectURL(blob);
    audio = new Audio(objectURL);
    audio.onplaying = () => {
      channel.postMessage({ type: "audio", playing: true });
      avatar.play("talk");
    };
    audio.onended = stopAudio;
    audio.onerror = () => {
      stopAudio();
      error("这段声音没有播放成功，可以再试一次。 ");
    };
    await audio.play();
  } catch (e) {
    if (!controller.signal.aborted) {
      stopAudio();
      error(errorText(e));
    }
  }
}
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
    p.textContent = "唔，我是煤球。想聊代码，还是聊聊今天？";
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
    $("model").value = s.settings.model;
    void client
      .request("/v1/voice-input")
      .then((config) => voice.configure(config))
      .catch(() => {
        initialized = false;
      });
  }
  $("disclosure").hidden = s.settings.remoteDisclosureAcknowledged;
  $("focus").checked = s.settings.focused;
  $("send").disabled =
    sending ||
    !client.connected ||
    !s.settings.remoteDisclosureAcknowledged ||
    !s.model.configured;
  $("cancel-run").hidden = !client.activeRun();
  $("run-status").textContent = client.activeRun()
    ? window.companionRunStatus(client.activeRun(), "煤球", Date.now())
    : !s.model.configured
      ? "先在下方模型设置里填写Key，就可以聊天啦。"
      : "";
  if (!playingMessage) avatar.play(client.activeRun() ? "think" : "idle");
  else if (
    playingMessage.epoch !== s.settings.epoch ||
    !s.messages.some(
      (m) =>
        m.id === playingMessage.id &&
        m.revision === playingMessage.revision &&
        !m.deleted,
    )
  )
    stopAudio();
  voice?.contextChanged();
  renderMessages(s);
}
client.addEventListener("change", render);
client.addEventListener("privacy-reset", () => {
  stopAudio();
  voice?.cancel();
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
$("allow-chat").addEventListener("click", async () => {
  try {
    await client.settings({ remoteDisclosureAcknowledged: true });
    error("");
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
$("model-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const model = $("model").value,
    key = $("model-key").value.trim();
  try {
    if (key) {
      await client.request(
        `/v1/model-credentials/${model === "grok-4.3" ? "grok" : "deepseek"}`,
        "PUT",
        { apiKey: key },
      );
      $("model-key").value = "";
      await client.refresh();
    }
    await client.settings({ model });
    error("");
  } catch (e) {
    error(errorText(e));
  }
});
$("voice-stop").addEventListener("click", stopAudio);
channel.onmessage = ({ data }) => {
  if (data.type === "stop-audio") {
    stopAudio();
    voice?.cancel();
  }
};
if (desktop) {
  $("show-pet").hidden = false;
  $("show-pet").addEventListener("click", () => desktop.showPet());
}
const off = desktop?.onControl((data) => {
  if (data.type === "suspended" && data.value) {
    stopAudio();
    voice?.cancel();
  }
  if (data.type === "size") $("pet-size").value = String(data.value);
});
voice = window.createVoiceInput({
  getContext: () =>
    client.snapshot
      ? {
          botId: "meiqiu",
          epoch: client.snapshot.settings.epoch,
          csrf: client.boot.csrfToken,
          allowed: client.snapshot.settings.remoteDisclosureAcknowledged,
        }
      : null,
  stopPlayback: stopAudio,
  appendText: (text) => {
    $("draft").value += ($("draft").value ? "\n" : "") + text;
    saveDraft();
    $("draft").focus();
  },
});
try {
  await avatar.ready();
  await client.start();
  if (client.snapshot) {
    $("model").value = client.snapshot.settings.model;
    voice.configure(await client.request("/v1/voice-input"));
  }
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
    voice.cancel();
  }
});
window.addEventListener("beforeunload", () => {
  off?.();
  stopAudio();
  voice.cancel();
  client.close();
  avatar.close();
  channel.close();
});
