const $ = (id) => document.getElementById(id);
const lines = {
  idle: "唔，我在这里陪你。",
  walk: "慢慢走两步，等你回来。",
  talk: "今天有什么想和我聊的呀？",
  think: "让我把小脑袋转一转……",
  code: "你写代码，我也敲敲小键盘。",
  happy: "这一小步完成啦！",
  sleep: "我在旁边打个小盹。",
  wave: "嗨，今天也一起努力吧。",
  fruit: "这么大一颗果子，我要慢慢啃。",
  heart: "给你一颗小小的桃心。",
  sign: "飞飞爱你。",
  cake: "背好小蛋糕，开开心心来找你。",
};
let manifest,
  images = new Map(),
  selected = "idle",
  elapsed = 0,
  previous = 0;
let paused = false,
  speed = 1,
  demoStart = null;
const previews = [];
function select(id, fromDemo = false) {
  if (!fromDemo) demoStart = null;
  selected = id;
  elapsed = 0;
  $("bubble").textContent = lines[id];
  document
    .querySelectorAll("[data-action]")
    .forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.action === id)),
    );
}
function frameAt(clip, ms, repeat = clip.loop) {
  let time = repeat ? ms % clip.durationMs : Math.min(ms, clip.durationMs - 1);
  for (let i = 0; i < clip.frames.length; i++) {
    if (time < clip.frames[i].durationMs) return i;
    time -= clip.frames[i].durationMs;
  }
  return clip.frames.length - 1;
}
function draw(canvas, id, index) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 128, 128);
  const r = manifest.animations[id].frames[index].rect;
  ctx.drawImage(images.get(id), r.x, r.y, r.w, r.h, 0, 0, 128, 128);
}
function animate(now) {
  const delta = previous ? Math.min(100, now - previous) : 0;
  previous = now;
  if (!paused) {
    elapsed += delta * speed;
    if (demoStart !== null) {
      demoStart += delta * speed;
      const id =
        demoStart < 2100
          ? "think"
          : demoStart < 6100
            ? "code"
            : demoStart < 7180
              ? "happy"
              : "idle";
      if (selected !== id) select(id, true);
      if (demoStart >= 9000) demoStart = null;
    } else if (
      !manifest.animations[selected].loop &&
      elapsed >= manifest.animations[selected].durationMs
    )
      select("idle", true);
  }
  const clip = manifest.animations[selected];
  const frame = frameAt(clip, elapsed);
  draw($("pet"), selected, frame);
  $("current").textContent =
    `${clip.label} · ${frame + 1} / ${clip.frameCount}`;
  for (const p of previews) {
    if (!paused) p.elapsed += delta * speed;
    draw(p.canvas, p.id, frameAt(manifest.animations[p.id], p.elapsed, true));
  }
  window.hedgehogPreview = {
    ready: true,
    selected,
    frame,
    paused,
    size: Number($("size").value),
    animationCount: images.size,
  };
  requestAnimationFrame(animate);
}
try {
  const response = await fetch("manifest.json");
  if (!response.ok) throw new Error("播放清单尚未生成，请先构建素材。");
  manifest = await response.json();
  $("summary").textContent =
    `暖栗棕小刺猬 · ${Object.keys(manifest.animations).length}段动画 / ${Object.values(manifest.animations).reduce((count, clip) => count + clip.frameCount, 0)}帧`;
  await Promise.all(
    Object.entries(manifest.animations).map(async ([id, clip]) => {
      const image = new Image();
      image.src = clip.sheet;
      await image.decode();
      images.set(id, image);
    }),
  );
  for (const [id, clip] of Object.entries(manifest.animations)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = id;
    button.textContent = clip.label;
    button.addEventListener("click", () => select(id));
    $("actions").append(button);
    const tile = document.createElement("div");
    tile.className = "tile";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    canvas.setAttribute("aria-label", clip.label);
    const label = document.createElement("span");
    label.textContent = clip.label;
    const info = document.createElement("small");
    info.textContent = `8帧 · ${(clip.durationMs / 1000).toFixed(2)}秒`;
    tile.append(canvas, label, info);
    $("gallery").append(tile);
    previews.push({ id, canvas, elapsed: 0 });
  }
  $("size").addEventListener("change", () => {
    $("pet").style.width = $("pet").style.height = `${$("size").value}px`;
  });
  $("speed").addEventListener("change", () => {
    speed = Number($("speed").value);
  });
  $("background").addEventListener("change", () => {
    $("stage").dataset.background = $("background").value;
  });
  $("pause").addEventListener("click", () => {
    paused = !paused;
    $("pause").textContent = paused ? "继续播放" : "暂停";
  });
  $("demo").addEventListener("click", () => {
    select("think");
    demoStart = 0;
    paused = false;
    $("pause").textContent = "暂停";
  });
  select("idle");
  requestAnimationFrame(animate);
} catch (error) {
  $("error").hidden = false;
  $("error").textContent = `预览未能载入：${error.message}`;
}
