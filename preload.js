'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let askCounter = 0;

contextBridge.exposeInMainWorld('jarvis', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listVoices: () => ipcRenderer.invoke('tts:voices'),
  synthesize: (opts) => ipcRenderer.invoke('tts:synthesize', opts),
  getWeather: (lat, lon) => ipcRenderer.invoke('weather:get', lat, lon),
  searchCity: (query) => ipcRenderer.invoke('geo:search', query),
  getNews: (feeds) => ipcRenderer.invoke('news:get', feeds),
  askAi: async (req, onSentence) => {
    const id = ++askCounter;
    const listener = (_e, m) => { if (m.id === id) onSentence(m.text); };
    ipcRenderer.on('ai:sentence', listener);
    try {
      return await ipcRenderer.invoke('ai:ask', { ...req, id });
    } finally {
      ipcRenderer.removeListener('ai:sentence', listener);
    }
  },
  transcribe: (audio, mime) => ipcRenderer.invoke('stt:transcribe', { audio, mime }),
  cancelAi: () => ipcRenderer.invoke('ai:cancel'),
  aiKeyStatus: () => ipcRenderer.invoke('ai:key-status'),
  setAiKey: (key) => ipcRenderer.invoke('ai:key-set', key),
  openLink: (url) => ipcRenderer.invoke('shell:open', url),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  quit: () => ipcRenderer.invoke('app:quit'),
});
