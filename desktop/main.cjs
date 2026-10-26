const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  powerMonitor,
  session,
  systemPreferences,
  shell,
} = require("electron");
const {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} = require("node:fs");
const { resolve, join } = require("node:path");

const root = resolve(__dirname, "..");
const dataDir = resolve(
  process.env.PET_DATA_DIR || join(root, "local-data/hedgehog-app"),
);
const backend = process.env.PET_BACKEND_URL || "http://127.0.0.1:4348";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(backend))
  throw new Error("Invalid local bot address");
mkdirSync(join(dataDir, "desktop-state"), { recursive: true, mode: 0o700 });
app.setName("煤球");
app.setPath("userData", join(dataDir, "desktop-state"));
const preferencesPath = join(dataDir, "desktop-preferences.json");
const prefs = { size: 128, x: null, y: null, paused: false, sleep: false };
try {
  const old = JSON.parse(readFileSync(preferencesPath, "utf8"));
  if ([64, 96, 128, 192].includes(old.size)) prefs.size = old.size;
  if (Number.isInteger(old.x) && Number.isInteger(old.y)) {
    prefs.x = old.x;
    prefs.y = old.y;
  }
} catch {}
let pet,
  chat,
  tray,
  drag = null,
  quitting = false,
  positionTimer,
  voicePanelOpen = false,
  setupReady = false;
function save() {
  if (pet && !pet.isDestroyed()) {
    const b = pet.getBounds();
    const normal = {
      width: Math.max(224, prefs.size + 112),
      height: prefs.size + 108,
    };
    prefs.x = Math.round(b.x + (b.width - normal.width) / 2);
    prefs.y = Math.round(b.y + b.height - normal.height);
  }
  const temp = `${preferencesPath}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify({ size: prefs.size, x: prefs.x, y: prefs.y }),
    { mode: 0o600 },
  );
  renameSync(temp, preferencesPath);
}
function control(value) {
  for (const win of [pet, chat])
    if (win && !win.isDestroyed()) win.webContents.send("coal:control", value);
}
function trusted(event, petOnly = false) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const allowed =
    win === pet
      ? [`${backend}/pet`]
      : win === chat && !petOnly
        ? [`${backend}/pet/chat`, `${backend}/pet/setup`]
        : [];
  return (
    event.senderFrame === event.sender.mainFrame &&
    allowed.includes(event.senderFrame.url)
  );
}

function bounds(size) {
  return {
    width: voicePanelOpen ? 344 : Math.max(224, size + 112),
    height: size + (voicePanelOpen ? 310 : 108),
  };
}
function clamp(rect, area) {
  return {
    ...rect,
    x: Math.round(
      Math.max(area.x, Math.min(area.x + area.width - rect.width, rect.x)),
    ),
    y: Math.round(
      Math.max(area.y, Math.min(area.y + area.height - rect.height, rect.y)),
    ),
  };
}
async function openPage(page) {
  const url = `${backend}/pet/${page}`;
  if (chat.webContents.getURL() !== url) await chat.loadURL(url);
  chat.show();
  chat.focus();
}
async function readSetupReady() {
  const boot = await fetch(`${backend}/bootstrap?botId=meiqiu`, {
    signal: AbortSignal.timeout(3000),
  });
  const cookie = boot.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw Error("local_session_missing");
  const response = await fetch(`${backend}/v1/pet/setup`, {
    headers: { cookie },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw Error("local_setup_unavailable");
  return (await response.json()).ready === true;
}
function openChat() {
  void readSetupReady()
    .then((ready) => {
      setupReady = ready;
      return openPage(ready ? "chat" : "setup");
    })
    .catch(() => {});
}
function setVoicePanel(value) {
  if (value === voicePanelOpen) return;
  const old = pet.getBounds();
  voicePanelOpen = value;
  const next = bounds(prefs.size);
  pet.setBounds(
    clamp(
      {
        ...next,
        x: old.x + (old.width - next.width) / 2,
        y: old.y + old.height - next.height,
      },
      screen.getDisplayMatching(old).workArea,
    ),
  );
  if (value) pet.setIgnoreMouseEvents(false);
}
function setSize(size) {
  if (![64, 96, 128, 192].includes(size)) return;
  const old = pet.getBounds(),
    next = bounds(size);
  const rect = {
    ...next,
    x: old.x + (old.width - next.width) / 2,
    y: old.y + old.height - next.height,
  };
  prefs.size = size;
  pet.setBounds(clamp(rect, screen.getDisplayMatching(old).workArea));
  save();
  control({ type: "size", value: size });
}
function menu() {
  return Menu.buildFromTemplate([
    { label: "和煤球聊聊天", click: openChat },
    { label: "显示煤球", click: () => pet.showInactive() },
    { type: "separator" },
    {
      label: "显示大小",
      submenu: [64, 96, 128, 192].map((size) => ({
        label: `${size} px`,
        type: "radio",
        checked: prefs.size === size,
        click: () => setSize(size),
      })),
    },
    {
      label: "来个小动作",
      submenu: [
        ["fruit", "吃大果子"],
        ["heart", "比心冒桃心"],
        ["sign", "飞飞爱你"],
        ["cake", "背蛋糕"],
        ["wave", "挥手"],
      ].map(([id, label]) => ({
        label,
        click: () => control({ type: "action", id }),
      })),
    },
    {
      label: "暂停动画",
      type: "checkbox",
      checked: prefs.paused,
      click: (item) => {
        prefs.paused = item.checked;
        control({ type: "paused", value: prefs.paused });
      },
    },
    {
      label: "打个小盹",
      type: "checkbox",
      checked: prefs.sleep,
      click: (item) => {
        prefs.sleep = item.checked;
        control({ type: "sleep", value: prefs.sleep });
      },
    },
    { type: "separator" },
    { label: "退出煤球", click: () => app.quit() },
  ]);
}
function guard(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (
      ![
        `${backend}/pet`,
        `${backend}/pet/chat`,
        `${backend}/pet/setup`,
      ].includes(url)
    )
      event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (chat && !chat.isDestroyed()) openChat();
  });
  app
    .whenReady()
    .then(async () => {
      const microphoneAllowed = (contents) =>
        contents === pet?.webContents &&
        contents.getURL() === `${backend}/pet` &&
        pet.isVisible() &&
        voicePanelOpen;
      session.defaultSession.setPermissionCheckHandler(
        (contents, permission, origin, details) =>
          permission === "media" &&
          origin.replace(/\/$/, "") === backend &&
          details.mediaType !== "video" &&
          microphoneAllowed(contents),
      );
      session.defaultSession.setPermissionRequestHandler(
        (contents, permission, callback, details) =>
          callback(
            permission === "media" &&
              !details.mediaTypes?.includes("video") &&
              microphoneAllowed(contents),
          ),
      );
      const area = screen.getPrimaryDisplay().workArea,
        size = bounds(prefs.size);
      const initial = {
        ...size,
        x: prefs.x ?? area.x + area.width - size.width - 24,
        y: prefs.y ?? area.y + area.height - size.height - 16,
      };
      const matching = screen.getDisplayMatching(initial).workArea;
      const webPreferences = {
        preload: join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: true,
        spellcheck: false,
      };
      pet = new BrowserWindow({
        ...clamp(initial, matching),
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        webPreferences,
      });
      chat = new BrowserWindow({
        width: 460,
        height: 720,
        frame: false,
        minWidth: 380,
        minHeight: 560,
        title: "和煤球聊聊天",
        backgroundColor: "#f7f5f2",
        show: false,
        webPreferences,
      });
      guard(pet);
      guard(chat);
      pet.setIgnoreMouseEvents(true, { forward: true });
      if (process.platform === "darwin")
        pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      chat.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          chat.hide();
        }
      });
      pet.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          pet.hide();
        }
      });
      pet.on("moved", () => {
        clearTimeout(positionTimer);
        positionTimer = setTimeout(save, 200);
      });
      screen.on("display-removed", () => {
        if (!pet.isDestroyed())
          pet.setBounds(
            clamp(pet.getBounds(), screen.getPrimaryDisplay().workArea),
          );
      });
      ipcMain.on("coal:hide-chat", (event) => {
        if (trusted(event)) chat.hide();
      });
      ipcMain.on("coal:open-setup", (event) => {
        if (trusted(event)) void openPage("setup");
      });
      ipcMain.on("coal:setup-done", async (event) => {
        if (!trusted(event)) return;
        try {
          setupReady = await readSetupReady();
          if (setupReady) await openPage("chat");
        } catch {}
      });
      ipcMain.on("coal:service", (event, service) => {
        if (!trusted(event)) return;
        const url = {
          deepseek: "https://platform.deepseek.com/",
          fish: "https://fish.audio/",
        }[service];
        if (typeof url === "string") void shell.openExternal(url);
      });
      ipcMain.handle("coal:microphone", async (event) => {
        if (!trusted(event, true) || !voicePanelOpen) return false;
        if (process.platform === "darwin")
          return systemPreferences.askForMediaAccess("microphone");
        return (
          systemPreferences.getMediaAccessStatus("microphone") !== "denied"
        );
      });
      ipcMain.on("coal:voice-panel", (event, value) => {
        if (trusted(event, true)) setVoicePanel(value === true);
      });
      ipcMain.on("coal:open-voice", (event) => {
        if (trusted(event)) {
          pet.show();
          pet.focus();
          control({ type: "voice-start" });
        }
      });
      ipcMain.on("coal:open-chat", (event) => {
        if (trusted(event)) openChat();
      });
      ipcMain.on("coal:show-pet", (event) => {
        if (trusted(event)) pet.showInactive();
      });
      ipcMain.on("coal:interactive", (event, value) => {
        if (trusted(event, true) && !drag)
          pet.setIgnoreMouseEvents(value !== true, { forward: true });
      });
      ipcMain.on("coal:drag-start", (event) => {
        if (trusted(event, true)) {
          drag = {
            point: screen.getCursorScreenPoint(),
            rect: pet.getBounds(),
          };
          pet.setIgnoreMouseEvents(false);
        }
      });
      ipcMain.on("coal:drag-move", (event) => {
        if (!trusted(event, true) || !drag) return;
        const point = screen.getCursorScreenPoint();
        pet.setBounds(
          clamp(
            {
              ...drag.rect,
              x: drag.rect.x + point.x - drag.point.x,
              y: drag.rect.y + point.y - drag.point.y,
            },
            screen.getDisplayNearestPoint(point).workArea,
          ),
        );
      });
      ipcMain.on("coal:drag-end", (event) => {
        if (trusted(event, true)) {
          drag = null;
          save();
        }
      });
      ipcMain.on("coal:menu", (event) => {
        if (trusted(event, true)) menu().popup({ window: pet });
      });
      ipcMain.handle("coal:size", (event, size) => {
        if (trusted(event)) setSize(size);
        return { size: prefs.size };
      });
      ipcMain.handle("coal:preferences", (event) =>
        trusted(event)
          ? { size: prefs.size, paused: prefs.paused, sleep: prefs.sleep }
          : null,
      );
      for (const name of ["lock-screen", "suspend"])
        powerMonitor.on(name, () =>
          control({ type: "suspended", value: true }),
        );
      for (const name of ["unlock-screen", "resume"])
        powerMonitor.on(name, () =>
          control({ type: "suspended", value: false }),
        );
      setupReady = await readSetupReady();
      await Promise.all([
        pet.loadURL(`${backend}/pet`),
        chat.loadURL(`${backend}/pet/${setupReady ? "chat" : "setup"}`),
      ]);
      if (!setupReady) {
        chat.show();
        chat.focus();
      }
      const icon = nativeImage
        .createFromPath(join(root, "assets/hedgehog/v1/frames/idle/00.png"))
        .resize({ width: 18, height: 18 });
      if (process.platform === "darwin") icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.setToolTip("煤球 · 你的刺猬小伙伴");
      tray.on("click", openChat);
      tray.on("right-click", () => tray.popUpContextMenu(menu()));
      pet.showInactive();
      if (process.platform === "darwin") app.dock?.hide();
      console.log("煤球桌宠已就绪。单击展开语音，按住按钮说话；双击文字聊天。");
    })
    .catch(() => {
      console.error("桌宠窗口启动失败。");
      app.exit(1);
    });
}
process.on("message", (message) => {
  if (message?.type === "pet-quit") app.quit();
});
app.on("before-quit", () => {
  quitting = true;
  clearTimeout(positionTimer);
  if (pet && !pet.isDestroyed()) save();
});
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});
