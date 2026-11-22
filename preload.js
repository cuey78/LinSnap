// Isolated preload. Exposes one narrow RPC that the main-world wrapper script
// (renderer-snapx.js) calls to request media transcoding, plus a debug log
// pipe. contextBridge exposures are visible to the page's main world as well,
// so no Node APIs are leaked to the page itself: only these two plain
// functions, validated again in the main process.
const { contextBridge, ipcRenderer } = require('electron');

// Uint8Array/ArrayBuffer pass through contextBridge + invoke intact (verified
// empirically on this Electron build), so media bytes cross as raw typed
// arrays; strings are accepted as a fallback.
contextBridge.exposeInMainWorld('__snapxInternal', {
    transcode: (data) => ipcRenderer.invoke('snapx-transcode', data),
    log: (msg) => {
        try { ipcRenderer.send('snapx-log', String(msg).slice(0, 400)); } catch { /* ignore */ }
    }
});
