const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rp', {
  submit: (spec) => ipcRenderer.send('ct:remote-submit', spec),
  cancel: () => ipcRenderer.send('ct:remote-cancel'),
});
