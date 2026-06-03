// Safely open a small window for actions that need a native dialog, like "switch project", for the web page to use.
// The page itself runs on http://localhost (the core service) with no node access; here contextBridge
// exposes only a few explicit methods, so the buttons in the bottom bar can ask Electron to open a folder picker.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codetree', {
  // Open the native folder picker; once chosen, switch to that project (main restarts core and reloads the page)
  pickProject: () => ipcRenderer.invoke('ct:pick-project'),
  // Go back to a plain terminal, not tied to any project
  openNoProject: () => ipcRenderer.invoke('ct:open-no-project'),
});
