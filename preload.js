const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  on: (c, f) => ipcRenderer.on(c, (_, d) => f(d)),
  invoke: (c, d) => ipcRenderer.invoke(c, d)
});
