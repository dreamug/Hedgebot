import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const root = resolve("assets/hedgehog/v1");
const manifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
const clips = Object.entries(manifest.animations);
assert.equal(clips.length, 12);
assert.equal(
  clips.reduce((n, [, c]) => n + c.frameCount, 0),
  96,
);
for (const [, clip] of clips) {
  assert.equal(clip.frameCount, 8);
  for (const frame of clip.frames) {
    const png = await readFile(join(root, frame.file));
    assert.equal(png.readUInt32BE(16), 128);
    assert.equal(png.readUInt32BE(20), 128);
  }
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("requestfailed", (request) =>
  errors.push(`${request.url()}: ${request.failure()?.errorText}`),
);
page.on("response", (response) => {
  if (response.status() >= 400)
    errors.push(`${response.status()}: ${response.url()}`);
});
try {
  await page.clock.install();
  await page.goto("http://127.0.0.1:4347/");
  await page.waitForFunction(() => window.hedgehogPreview?.ready === true);
  assert.equal(await page.locator("#gallery canvas").count(), 12);
  assert.equal(await page.locator("[data-action]").count(), 12);
  const checks = [];
  for (const [id] of clips) {
    await page.locator(`[data-action="${id}"]`).click();
    await page.clock.runFor(50);
    assert.equal(
      await page.evaluate(() => window.hedgehogPreview.selected),
      id,
    );
    await page.clock.runFor(500);
    checks.push({
      id,
      frameAfter500ms: await page.evaluate(() => window.hedgehogPreview.frame),
    });
  }
  await page.locator('[data-action="happy"]').click();
  await page.clock.runFor(1600);
  assert.equal(
    await page.evaluate(() => window.hedgehogPreview.selected),
    "idle",
  );
  await page.selectOption("#size", "64");
  assert.equal(
    await page
      .locator("#pet")
      .evaluate((el) => el.getBoundingClientRect().width),
    64,
  );
  await page.selectOption("#size", "128");
  await page.locator("#pause").click();
  await page.clock.runFor(50);
  const pausedFrame = await page.evaluate(() => window.hedgehogPreview.frame);
  await page.clock.runFor(1200);
  assert.equal(
    await page.evaluate(() => window.hedgehogPreview.frame),
    pausedFrame,
  );
  await page.locator("#pause").click();
  await page.locator("#demo").click();
  await page.clock.runFor(2800);
  assert.equal(
    await page.evaluate(() => window.hedgehogPreview.selected),
    "code",
  );
  await page.clock.runFor(5000);
  assert.equal(
    await page.evaluate(() => window.hedgehogPreview.selected),
    "idle",
  );
  const captureDir = resolve("local-data/hedgehog-research/showcase");
  await mkdir(captureDir, { recursive: true });
  await page
    .locator("#gallery")
    .screenshot({ path: join(root, "previews", "contact-sheet.png") });
  for (let i = 0; i < 40; i++) {
    await page.clock.runFor(100);
    await page
      .locator("#gallery")
      .screenshot({
        path: join(captureDir, `${String(i).padStart(2, "0")}.png`),
      });
  }
  const gif = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      "10",
      "-i",
      join(captureDir, "%02d.png"),
      "-filter_complex",
      "[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=none",
      "-loop",
      "0",
      join(root, "previews", "actions-overview.gif"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(gif.status, 0, gif.stderr || String(gif.error));
  await page.selectOption("#background", "dark");
  await page.screenshot({
    path: join(root, "previews", "desktop-preview.png"),
    fullPage: true,
  });
  await page.selectOption("#background", "check");
  await page.locator('[data-action="sign"]').click();
  await page.clock.runFor(500);
  await page.screenshot({
    path: join(root, "previews", "transparency-preview.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    animations: 12,
    frames: 96,
    controls: [
      "size-64",
      "pause-resume",
      "dark-background",
      "checker-background",
      "single-shot-return",
      "coding-demo",
      "mobile-no-overflow",
    ],
    clips: checks,
    browserErrors: errors,
  };
  await writeFile(
    join(root, "preview-qa.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
