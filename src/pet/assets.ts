import { readFileSync } from "node:fs";
import { join } from "node:path";

export function petAssets(projectRoot: string, mode: string) {
  const assets = new Map<string, { type: string; body: Buffer }>();
  for (const [route, file, type] of [
    ["/pet", "pet.html", "text/html; charset=utf-8"],
    ["/pet/chat", "chat.html", "text/html; charset=utf-8"],
    ["/pet/setup", "setup.html", "text/html; charset=utf-8"],
    ["/pet/setup.js", "setup.js", "text/javascript; charset=utf-8"],
    ["/pet/pcm-worklet.js", "pcm-worklet.js", "text/javascript; charset=utf-8"],
    ["/pet/voice.js", "voice.js", "text/javascript; charset=utf-8"],
    ["/pet/audio.js", "audio.js", "text/javascript; charset=utf-8"],
    ["/pet/pet.js", "pet.js", "text/javascript; charset=utf-8"],
    ["/pet/chat.js", "chat.js", "text/javascript; charset=utf-8"],
    ["/pet/client.js", "client.js", "text/javascript; charset=utf-8"],
    ["/pet/sprite.js", "sprite.js", "text/javascript; charset=utf-8"],
    ["/pet/pet.css", "pet.css", "text/css; charset=utf-8"],
  ])
    assets.set(route!, {
      type: type!,
      body: readFileSync(join(projectRoot, "web/pet", file!)),
    });
  const art = join(projectRoot, "assets/hedgehog/v1");
  assets.set("/pet/art/manifest.json", {
    type: "application/json",
    body: readFileSync(join(art, "manifest.json")),
  });
  for (const id of [
    "idle",
    "walk",
    "talk",
    "think",
    "code",
    "happy",
    "sleep",
    "wave",
    "fruit",
    "heart",
    "sign",
    "cake",
  ])
    assets.set(`/pet/art/sheets/${id}.png`, {
      type: "image/png",
      body: readFileSync(join(art, "sheets", `${id}.png`)),
    });
  assets.set("/pet/config.json", {
    type: "application/json",
    body: Buffer.from(
      JSON.stringify({
        kind: "hedgehog-desktop-v1",
        uiVersion: 2,
        botId: "meiqiu",
        mode,
      }),
    ),
  });
  return assets;
}
