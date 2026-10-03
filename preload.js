'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listVoices: () => ipcRenderer.invoke('tts:voices'),
  synthesize: (opts) => ipcRenderer.invoke('tts:synthesize', opts),
  getWeather: (lat, lon) => ipcRenderer.invoke('weather:get', lat, lon),
  searchCity: (query) => ipcRenderer.invoke('geo:search', query),
  getNews: (feeds) => ipcRenderer.invoke('news:get', feeds),
  openLink: (url) => ipcRenderer.invoke('shell:open', url),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  quit: () => ipcRenderer.invoke('app:quit'),
});
