// 把「切換專案」這種需要原生對話框的動作，安全地開一個小窗給網頁用。
// 網頁本身跑在 http://localhost（core 服務），沒有 node 權限；這裡用 contextBridge
// 只露出幾個明確的方法，網頁按底下那條列的按鈕就能請 Electron 開資料夾選擇器。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codetree', {
  // 開原生資料夾選擇器，選了就切到那個專案（main 會重啟 core 並重載頁面）
  pickProject: () => ipcRenderer.invoke('ct:pick-project'),
  // 回到單純終端機、不綁專案
  openNoProject: () => ipcRenderer.invoke('ct:open-no-project'),
});
