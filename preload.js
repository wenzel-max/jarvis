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
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleConnect: (creds) => ipcRenderer.invoke('google:connect', creds),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  agendaToday: () => ipcRenderer.invoke('agenda:today'),
  spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifyConnect: (creds) => ipcRenderer.invoke('spotify:connect', creds),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),
  mediaControl: (action, value) => ipcRenderer.invoke('media:control', { action, value }),
  transcribe: (audio, mime) => ipcRenderer.invoke('stt:transcribe', { audio, mime }),
  cancelAi: () => ipcRenderer.invoke('ai:cancel'),
  aiKeyStatus: () => ipcRenderer.invoke('ai:key-status'),
  setAiKey: (key) => ipcRenderer.invoke('ai:key-set', key),
  openLink: (url) => ipcRenderer.invoke('shell:open', url),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  quit: () => ipcRenderer.invoke('app:quit'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
});
