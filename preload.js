const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog:  ()         => ipcRenderer.invoke('open-file-dialog'),
  readImage:       (filePath) => ipcRenderer.invoke('read-image', filePath),
  openFolder:      (filePath) => ipcRenderer.invoke('open-folder', filePath),
  generateDocx:    (slots)    => ipcRenderer.invoke('generate-docx', slots)
});
