import { PetClient, errorText } from "./client.js";
import { CoalSprite } from "./sprite.js";
const $ = (id) => document.getElementById(id),
  client = new PetClient(),
  sprite = new CoalSprite($("welcome-coal"));
$("window-close").addEventListener("click", () =>
  window.coalDesktop?.hideChat(),
);
document.querySelectorAll("[data-service]").forEach((button) =>
  button.addEventListener("click", () => {
    const service = button.dataset.service;
    if (window.coalDesktop) window.coalDesktop.openService(service);
    else
      window.open(
        service === "fish"
          ? "https://fish.audio/"
          : "https://platform.deepseek.com/",
        "_blank",
        "noopener",
      );
  }),
);
$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("setup-error").hidden = true;
  $("setup-save").disabled = true;
  const deepseekKey = $("deepseek-key").value.trim(),
    fishAudioKey = $("fish-key").value.trim();
  try {
    await client.request("/v1/pet/setup", "PUT", {
      ...(deepseekKey ? { deepseekKey } : {}),
      ...(fishAudioKey ? { fishAudioKey } : {}),
    });
    $("deepseek-key").value = $("fish-key").value = "";
    if (window.coalDesktop) await window.coalDesktop.setupDone();
    else location.replace("/pet/chat");
  } catch (error) {
    $("setup-error").hidden = false;
    $("setup-error").textContent = errorText(error);
  } finally {
    $("setup-save").disabled = false;
  }
});
try {
  await sprite.ready();
  await client.start();
  const setup = client.setup;
  for (const [id, configured] of [
    ["deepseek-key", setup?.deepseekConfigured],
    ["fish-key", setup?.fishAudioConfigured],
  ])
    if (configured) {
      $(id).required = false;
      $(id).placeholder = "已在本机保存，留空保留";
    }
  if (setup?.ready) {
    $("setup-save").firstChild.textContent = "保存连接 ";
    document.querySelector(".window-bar span").textContent = "煤球 · 连接设置";
  }
} catch {
  $("setup-error").hidden = false;
  $("setup-error").textContent = "还没连上本地服务，稍等片刻后重新打开。";
}
window.addEventListener("beforeunload", () => {
  client.close();
  sprite.close();
});
