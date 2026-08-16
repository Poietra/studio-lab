const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "poietraDesktop",
  Object.freeze({
    registerExistingWorkspace(name) {
      return ipcRenderer.invoke("poietra:register-existing-workspace", name);
    },
    savePythonSource(fileName, source) {
      return ipcRenderer.invoke("poietra:save-python-source", { fileName, source });
    },
    saveVideoFile(fileName, bytes) {
      return ipcRenderer.invoke("poietra:save-video-file", { bytes, fileName });
    },
  }),
);
