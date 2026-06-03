// 共用設定。CLI、core、web 三邊都讀這裡。
export const WS_PORT = 7778; // core WebSocket 廣播 state
export const WEB_PORT = 7790; // 視覺化網頁（7777 在某些機器被 IDE preview 幽靈占住，搬開）

// 哪些副檔名算「程式碼節點」（含 UI 檔，UI 檔點開可預覽渲染結果）
export const CODE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go',
  '.html', '.htm', '.svg', '.css', '.vue', '.svelte'];

// 預設忽略的目錄名（單純比目錄名，不用 glob）
export const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cosmos-tree',
];

// chokidar v4 拿掉了 glob，ignored 只吃 function/regex。
// 這個 predicate：路徑任一層命中忽略目錄名就跳過。
const IGNORE_RE = new RegExp(`(^|[\\\\/])(${IGNORE_DIRS.join('|')})([\\\\/]|$)`);
export function isIgnored(p) {
  return IGNORE_RE.test(p);
}

// 異常偵測門檻（對齊 spec 的 MVP 規則）
export const ANOMALY = {
  REPEAT_MODIFY: 3, // 同檔案被改 >= 3 次 → 閃紅
  STALL_MS: 10 * 60 * 1000, // 同節點 active 超過 10 分鐘無變化 → 卡住
};
