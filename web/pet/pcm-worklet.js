class CoalPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(Math.round(sampleRate / 10));
    this.offset = 0;
    this.flushed = false;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.send();
        this.flushed = true;
        this.port.postMessage({ type: "flushed" });
      }
    };
  }
  send() {
    if (!this.offset) return;
    const bytes = new ArrayBuffer(this.offset * 2),
      view = new DataView(bytes);
    for (let i = 0; i < this.offset; i++)
      view.setInt16(i * 2, this.buffer[i], true);
    this.port.postMessage({ type: "audio", bytes }, [bytes]);
    this.offset = 0;
  }
  process(inputs) {
    if (this.flushed) return true;
    const input = inputs[0]?.[0];
    if (input)
      for (const value of input) {
        this.buffer[this.offset++] = Math.round(
          Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767),
        );
        if (this.offset === this.buffer.length) this.send();
      }
    return true;
  }
}
registerProcessor("coal-pcm", CoalPCM);
