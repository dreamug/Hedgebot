const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "coalDesktop",
  Object.freeze({
    hideChat: () => ipcRenderer.send("coal:hide-chat"),
    openSetup: () => ipcRenderer.send("coal:open-setup"),
    setupDone: () => ipcRenderer.send("coal:setup-done"),
    openService: (service) => ipcRenderer.send("coal:service", service),
    microphone: () => ipcRenderer.invoke("coal:microphone"),
    voicePanel: (visible) =>
      ipcRenderer.send("coal:voice-panel", visible === true),
    openVoice: () => ipcRenderer.send("coal:open-voice"),
    openChat: () => ipcRenderer.send("coal:open-chat"),
    showPet: () => ipcRenderer.send("coal:show-pet"),
    setInteractive: (value) =>
      ipcRenderer.send("coal:interactive", value === true),
    beginDrag: () => ipcRenderer.send("coal:drag-start"),
    drag: () => ipcRenderer.send("coal:drag-move"),
    endDrag: () => ipcRenderer.send("coal:drag-end"),
    setSize: (size) => ipcRenderer.invoke("coal:size", size),
    menu: () => ipcRenderer.send("coal:menu"),
    preferences: () => ipcRenderer.invoke("coal:preferences"),
    onControl: (callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("coal:control", listener);
      return () => ipcRenderer.removeListener("coal:control", listener);
    },
  }),
);
