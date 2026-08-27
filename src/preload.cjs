const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('previewer', {
  guestPreloadPath: () => ipcRenderer.invoke('guest-preload-path'),
  emulate: (opts) => ipcRenderer.invoke('emulate', opts),
  openDevTools: (id) => ipcRenderer.invoke('open-devtools', { id }),
  clearStorage: (partition) => ipcRenderer.invoke('clear-storage', { partition }),
  capturePanel: (opts) => ipcRenderer.invoke('capture-panel', opts),
  reveal: (file) => ipcRenderer.invoke('reveal', { file }),
  platform: process.platform
})
