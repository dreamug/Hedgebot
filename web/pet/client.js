export class PetClient extends EventTarget {
  boot = null;
  snapshot = null;
  codex = null;
  setup = null;
  preferences = { voiceEnabled: true, autoSpeak: true };
  connected = false;
  controller = new AbortController();
  closed = false;
  refreshTimer = null;
  retryTimer = null;
  pollTimer = null;
  events = null;
  refreshing = false;
  again = false;
  minimumEpoch = 0;

  async request(path, method = "GET", body, retry = true) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      signal: this.controller.signal,
      headers: {
        "X-Bot-Id": "meiqiu",
        ...(body !== undefined
          ? {
              "Content-Type": "application/json",
              "X-Local-Token": this.boot?.csrfToken ?? "",
            }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 && retry && method === "GET") {
      await this.bootstrap();
      this.setup = await this.request("/v1/pet/setup");
      this.preferences = this.setup.preferences;
      return this.request(path, method, body, false);
    }
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error ?? "request_failed");
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async bootstrap() {
    this.boot = await this.request(
      "/bootstrap?botId=meiqiu",
      "GET",
      undefined,
      false,
    );
  }
  changed() {
    if (!this.closed) this.dispatchEvent(new Event("change"));
  }
  async start() {
    try {
      await this.bootstrap();
      this.setup = await this.request("/v1/pet/setup");
      this.preferences = this.setup.preferences;
      await this.refresh();
      if (this.closed) return;
      this.connect();
      this.pollCodex();
    } catch {
      this.connected = false;
      this.changed();
      this.retryTimer = setTimeout(() => {
        if (!this.closed) void this.start();
      }, 1500);
    }
  }
  async refresh() {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.again = false;
        const snapshot = await this.request(
          `/v1/relationships/${encodeURIComponent(this.boot.relationshipId)}/snapshot`,
        );
        if (this.closed) return;
        if (snapshot.settings.epoch < this.minimumEpoch)
          throw new Error("old_snapshot");
        if (
          this.snapshot &&
          this.snapshot.settings.epoch !== snapshot.settings.epoch
        )
          this.dispatchEvent(new Event("privacy-reset"));
        this.snapshot = snapshot;
        this.changed();
      } while (this.again && !this.closed);
    } finally {
      this.refreshing = false;
    }
  }
  connect() {
    this.events?.close();
    const stream = new EventSource(
      `/v1/relationships/${encodeURIComponent(this.boot.relationshipId)}/events?botId=meiqiu&cursor=${encodeURIComponent(this.snapshot.cursor)}`,
    );
    this.events = stream;
    stream.onopen = () => {
      this.connected = true;
      this.changed();
    };
    stream.addEventListener("update", (event) => {
      if (JSON.parse(event.data).type === "memory.invalidated") {
        this.minimumEpoch = Math.max(
          this.minimumEpoch,
          Number(event.lastEventId.split(":")[0]) || 0,
        );
        this.snapshot = null;
        this.dispatchEvent(new Event("privacy-reset"));
      }
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        void this.refresh().catch(() => this.reconnect());
      }, 70);
    });
    stream.addEventListener("resync", (event) => {
      this.minimumEpoch = Math.max(
        this.minimumEpoch,
        Number(JSON.parse(event.data).epoch) || 0,
      );
      this.snapshot = null;
      this.dispatchEvent(new Event("privacy-reset"));
      this.reconnect();
    });
    stream.onerror = () => this.reconnect();
  }
  reconnect() {
    if (this.closed) return;
    this.events?.close();
    this.connected = false;
    this.changed();
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      try {
        await this.bootstrap();
        await this.refresh();
        if (!this.closed) this.connect();
      } catch {
        this.reconnect();
      }
    }, 1500);
  }
  async pollCodex() {
    if (this.closed) return;
    try {
      this.codex = await this.request("/v1/pet/codex");
      this.setup = this.codex.setup;
      this.preferences = this.codex.preferences;
      this.changed();
    } catch {
      this.codex = null;
      this.changed();
    }
    if (!this.closed) this.pollTimer = setTimeout(() => this.pollCodex(), 1500);
  }
  async settings(patch) {
    const result = await this.request(
      `/v1/relationships/${encodeURIComponent(this.boot.relationshipId)}/settings`,
      "PATCH",
      { ...patch, expectedRevision: this.snapshot.settings.revision },
    );
    await this.refresh();
    return result;
  }
  async submit(text, idempotencyKey) {
    return this.request(
      `/v1/threads/${encodeURIComponent(this.boot.threadId)}/inputs`,
      "POST",
      { text, idempotencyKey },
    );
  }
  activeRun() {
    return this.snapshot?.runs.find((run) =>
      ["queued", "running"].includes(run.status),
    );
  }
  close() {
    this.closed = true;
    this.events?.close();
    this.controller.abort();
    for (const timer of [this.refreshTimer, this.retryTimer, this.pollTimer])
      clearTimeout(timer);
  }
}
export function errorText(error) {
  return (
    {
      remote_disclosure_required: "请先确认下方聊天外发说明。",
      model_key_missing: "请先在模型设置中填写 Key。",
      csrf_required: "会话已更新，请刷新后再试。",
      unauthorized: "连接正在恢复，请稍后重试。",
      run_queue_full: "正在处理的消息有点多，稍等一下。",
      revision_conflict: "设置刚有变化，请重新操作。",
      speech_key_missing: "尚未配置朗读服务。",
      speech_busy: "上一段声音正在结束，稍等一下。",
      pet_setup_required: "先连接 DeepSeek 和 Fish Audio，就能开始陪伴。",
    }[error.message] ??
    (error.status
      ? `这次没能完成，请稍后再试（${error.message}）。`
      : "暂时没有确认到结果，正在恢复连接；可稍后重试。")
  );
}
export function codexLabel(state) {
  if (!state || state.connection === "waiting") return "Codex尚未连接";
  if (state.connection === "unbound") return "请选择要陪伴的Codex会话";
  if (state.connection === "stale") return "Codex状态暂不可确认";
  return (
    {
      thinking: "Codex正在思考",
      coding: "Codex正在修改文件",
      attention: "Codex需要你确认",
      idle: "Codex这一回合已结束",
      ended: "Codex会话已结束",
    }[state.selected?.phase] ?? "Codex已连接"
  );
}
