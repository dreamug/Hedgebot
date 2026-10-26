function once(target, event, signal, failure = "error") {
  return new Promise((resolve, reject) => {
    const clean = () => {
      target.removeEventListener(event, ok);
      target.removeEventListener(failure, bad);
      signal.removeEventListener("abort", cancel);
    };
    const ok = () => {
        clean();
        resolve();
      },
      bad = () => {
        clean();
        reject(new Error("audio_playback_failed"));
      },
      cancel = () => {
        clean();
        reject(new DOMException("Stopped", "AbortError"));
      };
    if (signal.aborted) {
      cancel();
      return;
    }
    target.addEventListener(event, ok, { once: true });
    target.addEventListener(failure, bad, { once: true });
    signal.addEventListener("abort", cancel, { once: true });
  });
}
export class ReplyAudio extends EventTarget {
  constructor(client) {
    super();
    this.client = client;
    this.controller = null;
    this.audio = null;
    this.url = null;
    this.message = null;
  }
  stop() {
    this.controller?.abort();
    this.controller = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = null;
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.message = null;
    this.dispatchEvent(new Event("stopped"));
  }
  async play(message) {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    this.message = {
      id: message.id,
      revision: message.revision,
      epoch: this.client.snapshot.settings.epoch,
    };
    const signal = controller.signal,
      deadline = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch("/v1/speech", {
        method: "POST",
        credentials: "same-origin",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Bot-Id": "meiqiu",
          "X-Local-Token": this.client.boot.csrfToken,
        },
        body: JSON.stringify({
          kind: "message",
          id: message.id,
          expectedRevision: message.revision,
          expectedEpoch: this.message.epoch,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "speech_unavailable");
      }
      if (!/^audio\/mpeg/i.test(response.headers.get("content-type") ?? ""))
        throw new Error("speech_invalid_audio");
      const audio = new Audio();
      this.audio = audio;
      audio.onplaying = () => {
        if (!signal.aborted) this.dispatchEvent(new Event("playing"));
      };
      const ended = once(audio, "ended", signal);
      ended.catch(() => {});
      if (window.MediaSource?.isTypeSupported("audio/mpeg") && response.body) {
        const source = new MediaSource();
        this.url = URL.createObjectURL(source);
        audio.src = this.url;
        await once(source, "sourceopen", signal);
        const buffer = source.addSourceBuffer("audio/mpeg");
        buffer.mode = "sequence";
        const reader = response.body.getReader();
        let started = false;
        try {
          for (;;) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!chunk.value.length) continue;
            const updated = once(buffer, "updateend", signal);
            buffer.appendBuffer(chunk.value);
            await updated;
            if (!started) {
              started = true;
              await audio.play();
            }
          }
          if (!started) throw new Error("speech_empty_audio");
          if (source.readyState === "open") source.endOfStream();
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } else {
        const blob = await response.blob();
        signal.throwIfAborted();
        this.url = URL.createObjectURL(blob);
        audio.src = this.url;
        await audio.play();
      }
      await ended;
      signal.throwIfAborted();
    } finally {
      clearTimeout(deadline);
      if (this.controller === controller) this.stop();
    }
  }
}
