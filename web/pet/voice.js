import { errorText } from "./client.js";

export function voiceError(error) {
  const labels = {
    NotAllowedError: "麦克风还没有获准使用，请在系统设置中允许煤球访问麦克风。",
    NotFoundError: "没有找到麦克风。连接麦克风后再试一次。",
    NotReadableError: "麦克风正在被其他应用占用。",
    no_speech: "没有听清，按住按钮再说一次吧。",
    transcription_no_speech: "这次没有听清，重新说一句就好。",
    transcription_key_missing: "先填好 Fish Audio Key，就能听见你。",
    transcription_authentication_failed:
      "Fish Audio Key 没有通过，请检查后再试。",
    speech_authentication_failed: "Fish Audio Key 没有通过，请检查后再试。",
    transcription_balance_insufficient: "Fish Audio 余额不足，请补充后再试。",
    speech_balance_insufficient: "Fish Audio 余额不足，请补充后再试。",
    transcription_timeout: "听写等得有点久，这次没有发送，可以再试一次。",
    speech_timeout: "声音暂时没准备好，文字回复已经保留。",
    audio_playback_failed: "声音没能播放，文字回复已经保留。",
    transcription_connection_lost:
      "听写连接断开了，这次没有发送。按住按钮再试一次吧。",
    transcription_unavailable: "实时听写暂时没连上，这次没有发送。",
    transcription_degraded: "这次听写没有完整完成，请按住按钮重新说一次。",
    voice_busy: "还有一段语音正在进行，先结束它再说吧。",
    voice_disabled: "语音已暂停，可以在陪伴设置里重新开启。",
    pet_setup_required: "先连接 DeepSeek 和 Fish Audio。",
    epoch_conflict: "聊天设置已经更新，这段语音没有发送。请重新按住说话。",
    transcription_protocol_error:
      "听写没有完整完成，这次没有发送。请再试一次。",
  };
  return labels[error.name] ?? labels[error.message] ?? errorText(error);
}
export class VoiceConversation extends EventTarget {
  constructor(
    client,
    player,
    { onSetup = () => {}, permission = async () => true } = {},
  ) {
    super();
    this.client = client;
    this.player = player;
    this.onSetup = onSetup;
    this.permission = permission;
    this.state = "idle";
    this.detail = "";
    this.level = 0;
    this.serial = 0;
    this.runId = null;
    this.owned = new Set();
    this.busyReply = false;
    this.changed = () => this.observe();
    client.addEventListener("change", this.changed);
    this.reset = () => this.cancel();
    client.addEventListener("privacy-reset", this.reset);
    this.playing = () => {
      if (this.busyReply) this.set("speaking", this.detail);
    };
    player.addEventListener("playing", this.playing);
  }
  set(state, detail = "") {
    this.state = state;
    this.detail = detail;
    this.dispatchEvent(new Event("change"));
  }
  async start() {
    if (!this.client.setup?.ready) {
      this.onSetup();
      return;
    }
    if (!this.client.preferences.voiceEnabled) {
      this.set("error", "语音已暂停，可以在设置里重新开启。 ");
      return;
    }
    this.cancel();
    const serial = this.serial,
      epoch = this.client.snapshot?.settings.epoch;
    this.controller = new AbortController();
    this.epoch = epoch;
    this.transcript = "";
    this.set("permission", "正在接通麦克风，准备好后再说哦…");
    try {
      if (!(await this.permission()))
        throw Object.assign(new Error("microphone_denied"), {
          name: "NotAllowedError",
        });
      if (serial !== this.serial) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (serial !== this.serial) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.resume();
      if (serial !== this.serial) return;
      const session = await this.client.request(
        "/v1/pet/voice/sessions",
        "POST",
        { expectedEpoch: epoch, sampleRate: this.context.sampleRate },
      );
      if (serial !== this.serial) return;
      await this.context.audioWorklet.addModule("/pet/pcm-worklet.js");
      if (serial !== this.serial) return;
      const url = new URL(session.path, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, `coal-voice.${session.ticket}`);
      this.socket = socket;
      this.limit = setTimeout(
        () => this.fail(new Error("transcription_timeout"), serial),
        15000,
      );
      socket.onmessage = (event) => {
        if (serial !== this.serial) return;
        try {
          const value = JSON.parse(event.data);
          if (value.type === "ready") {
            clearTimeout(this.limit);
            this.beginCapture(stream, serial);
          } else if (value.type === "transcript") {
            this.transcript = value.text;
            this.detail = value.text || "正在听写…";
            this.dispatchEvent(new Event("change"));
          } else if (value.type === "done") {
            if (this.state !== "transcribing")
              throw new Error("transcription_protocol_error");
            clearTimeout(this.limit);
            this.releaseInput();
            this.socket = null;
            void this.submitTranscript(value.text, serial);
          } else if (value.type === "error")
            this.fail(new Error(value.error), serial);
        } catch (error) {
          this.fail(error, serial);
        }
      };
      socket.onerror = () =>
        this.fail(new Error("transcription_connection_lost"), serial);
      socket.onclose = () => {
        if (serial === this.serial && this.socket === socket)
          this.fail(new Error("transcription_connection_lost"), serial);
      };
    } catch (error) {
      this.fail(error, serial);
    }
  }
  beginCapture(stream, serial) {
    if (serial !== this.serial) return;
    const context = this.context,
      node = new AudioWorkletNode(context, "coal-pcm"),
      source = context.createMediaStreamSource(stream),
      mute = context.createGain();
    mute.gain.value = 0;
    this.node = node;
    this.source = source;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    node.port.onmessage = ({ data }) => {
      if (serial !== this.serial) return;
      if (data.type === "audio" && this.socket?.readyState === WebSocket.OPEN) {
        if (this.socket.bufferedAmount > 512000) {
          this.fail(new Error("transcription_connection_lost"), serial);
          return;
        }
        this.socket.send(data.bytes);
        const pcm = new Int16Array(data.bytes);
        this.level = Math.min(
          1,
          Math.sqrt(
            pcm.reduce((s, v) => s + (v / 32768) ** 2, 0) / pcm.length,
          ) * 8,
        );
        this.dispatchEvent(new Event("level"));
      } else if (data.type === "flushed" && this.state === "transcribing") {
        this.socket?.send(JSON.stringify({ type: "finish" }));
        this.releaseInput();
      }
    };
    this.limit = setTimeout(() => this.finish(), 45000);
    this.set("listening", "说吧，识别的文字会显示在这里。 ");
  }
  finish() {
    if (this.state === "permission") {
      this.cancel();
      return;
    }
    if (this.state !== "listening") return;
    clearTimeout(this.limit);
    this.set("transcribing", this.transcript || "正在确认最后几个字…");
    this.source?.disconnect();
    this.node?.port.postMessage("flush");
    const serial = this.serial;
    this.limit = setTimeout(
      () => this.fail(new Error("transcription_timeout"), serial),
      20000,
    );
  }
  releaseInput() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    this.node?.disconnect();
    this.node = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    this.level = 0;
  }
  async submitTranscript(text, serial) {
    try {
      if (
        serial !== this.serial ||
        this.client.snapshot?.settings.epoch !== this.epoch
      )
        return;
      if (!text?.trim()) throw new Error("no_speech");
      this.transcript = text.trim();
      this.set("waiting", this.transcript);
      this.key = crypto.randomUUID();
      const accepted = await this.client.submit(this.transcript, this.key);
      if (serial !== this.serial) {
        this.cancelRun(accepted.runId);
        return;
      }
      this.runId = accepted.runId;
      this.owned.add(this.runId);
      if (this.owned.size > 64)
        this.owned.delete(this.owned.values().next().value);
      await this.client.refresh();
      this.observe();
    } catch (error) {
      this.fail(error, serial);
    }
  }
  cancelRun(id) {
    void fetch(`/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Bot-Id": "meiqiu",
        "X-Local-Token": this.client.boot.csrfToken,
      },
      body: "{}",
    }).catch(() => {});
  }
  observe() {
    if (!this.runId || this.busyReply) return;
    const serial = this.serial;
    const run = this.client.snapshot?.runs.find((r) => r.id === this.runId);
    if (!run) return;
    if (["failed", "cancelled", "interrupted"].includes(run.status)) {
      this.runId = null;
      this.set(
        run.status === "failed" ? "error" : "idle",
        run.status === "failed" ? "这次没能回复，按住按钮再试一次吧。" : "",
      );
      return;
    }
    const reply = this.client.snapshot.messages.find(
      (m) =>
        m.runId === this.runId &&
        m.role === "assistant" &&
        m.status === "completed",
    );
    if (run.status !== "completed" || !reply) return;
    if (!this.client.preferences.autoSpeak) {
      this.runId = null;
      this.set("idle", reply.content);
      return;
    }
    this.busyReply = true;
    this.set("replying", reply.content);
    void this.player
      .play(reply)
      .then(() => {
        if (serial === this.serial) this.set("idle", reply.content);
      })
      .catch((error) => {
        if (serial === this.serial)
          this.set(
            error.name === "AbortError" ? "idle" : "error",
            error.name === "AbortError" ? reply.content : voiceError(error),
          );
      })
      .finally(() => {
        if (serial === this.serial) {
          this.runId = null;
          this.busyReply = false;
        }
      });
  }
  fail(error, serial) {
    if (serial !== this.serial) return;
    clearTimeout(this.limit);
    this.releaseInput();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    this.set("error", voiceError(error));
  }
  cancel() {
    this.serial++;
    clearTimeout(this.limit);
    this.controller?.abort();
    this.controller = null;
    this.releaseInput();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    if (this.runId) this.cancelRun(this.runId);
    this.runId = null;
    this.busyReply = false;
    this.player.stop();
    this.set("idle");
  }
  close() {
    this.cancel();
    this.client.removeEventListener("change", this.changed);
    this.client.removeEventListener("privacy-reset", this.reset);
    this.player.removeEventListener("playing", this.playing);
  }
}
