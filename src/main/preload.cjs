const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shotready', {
  call: (method, ...args) => ipcRenderer.invoke('shotready:call', method, args),
  on: (event, fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(`shotready:${event}`, handler);
    return () => ipcRenderer.removeListener(`shotready:${event}`, handler);
  },
});
