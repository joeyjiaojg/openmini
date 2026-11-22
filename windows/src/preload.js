// OpenMini Windows 宿主：把主进程能力安全暴露给启动器页面。
// 应用页面不加载本 preload，拿不到任何宿主能力（与 Android 的 prompt 白名单一致）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__om', {
  // 同步调用：apps / meta / market / updateCheck ...
  call: function (payload) {
    return ipcRenderer.sendSync('om-call', payload);
  },
  // 异步事件：onMarket / onProgress / onResult / onSelfUpdate ...
  onEvent: function (cb) {
    ipcRenderer.on('om-event', function (_e, ev) {
      try { cb(ev); } catch (err) { }
    });
  }
});
