const { contextBridge, ipcRenderer } = require('electron');

// Resolved once at load: where products.json and images actually live
const dataDir = ipcRenderer.sendSync('get-data-dir');

contextBridge.exposeInMainWorld('api', {
  dataDir,
  loadData: () => ipcRenderer.invoke('load-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  pickImage: (productId) => ipcRenderer.invoke('pick-image', productId),
  deleteImage: (relPath) => ipcRenderer.invoke('delete-image', relPath),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  confirmDialog: (message) => ipcRenderer.invoke('confirm', message),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  pickLogo: () => ipcRenderer.invoke('pick-logo'),
  removeLogo: () => ipcRenderer.invoke('remove-logo'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  resetData: () => ipcRenderer.invoke('reset-data'),
  findCheapest: (productId, mode) => ipcRenderer.invoke('find-cheapest', productId, mode),
  findAlternatives: (productId) => ipcRenderer.invoke('find-alternatives', productId),
  downloadImage: (productId, url) => ipcRenderer.invoke('download-image', productId, url),
  priceAlternatives: (productId, manufacturers) => ipcRenderer.invoke('price-alternatives', productId, manufacturers),
  onPriceProgress: (callback) => {
    ipcRenderer.on('price-progress', (event, payload) => callback(payload));
  }
});
