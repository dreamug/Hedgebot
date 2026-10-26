let artPromise;
export function loadArt() {
  artPromise ??= (async () => {
    const response = await fetch("/pet/art/manifest.json");
    if (!response.ok) throw new Error("art_unavailable");
    const manifest = await response.json();
    const images = new Map();
    await Promise.all(
      Object.entries(manifest.animations).map(async ([id, clip]) => {
        const image = new Image();
        image.src = `/pet/art/${clip.sheet}`;
        await image.decode();
        images.set(id, image);
      }),
    );
    return { manifest, images };
  })();
  return artPromise;
}
export class CoalSprite extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { willReadFrequently: true });
    this.action = null;
    this.frame = 0;
    this.paused = false;
    this.timer = null;
    this.disposed = false;
    this.visibility = () => {
      if (document.hidden) this.stopTimer();
      else this.paint();
    };
    document.addEventListener("visibilitychange", this.visibility);
  }
  async ready() {
    this.art = await loadArt();
    if (!this.disposed) this.play("idle");
    return this;
  }
  stopTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }
  play(action) {
    if (!this.art || !this.art.manifest.animations[action]) return;
    if (this.action === action) return;
    this.action = action;
    this.frame = 0;
    this.stopTimer();
    this.paint();
  }
  paint() {
    this.stopTimer();
    if (this.disposed || !this.art) return;
    const clip = this.art.manifest.animations[this.action];
    const r = clip.frames[this.frame].rect;
    this.context.clearRect(0, 0, 128, 128);
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(
      this.art.images.get(this.action),
      r.x,
      r.y,
      r.w,
      r.h,
      0,
      0,
      128,
      128,
    );
    this.canvas.dataset.action = this.action;
    this.canvas.dataset.frame = String(this.frame);
    this.dispatchEvent(new Event("frame"));
    if (this.paused || document.hidden) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.frame++;
      if (this.frame >= clip.frameCount) {
        this.frame = 0;
        if (!clip.loop) {
          this.dispatchEvent(
            new CustomEvent("complete", { detail: this.action }),
          );
          this.play("idle");
          return;
        }
      }
      this.paint();
    }, clip.frames[this.frame].durationMs);
  }
  pause(value) {
    this.paused = value;
    this.paint();
  }
  hit(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((clientX - r.left) * 128) / r.width),
      y = Math.floor(((clientY - r.top) * 128) / r.height);
    return (
      x >= 0 &&
      x < 128 &&
      y >= 0 &&
      y < 128 &&
      this.context.getImageData(x, y, 1, 1).data[3] > 0
    );
  }
  close() {
    this.disposed = true;
    this.stopTimer();
    document.removeEventListener("visibilitychange", this.visibility);
  }
}
