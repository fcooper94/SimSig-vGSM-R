const { DEFAULT_SETTINGS } = require('../shared/constants');

let store = null;

function initSettings() {
  // Require electron-conf lazily — it does require('electron') internally
  // and must be loaded after Electron's app module is available
  const { Conf } = require('electron-conf/main');
  store = new Conf({
    defaults: DEFAULT_SETTINGS,
  });
}

function get(key) {
  return store.get(key);
}

function set(key, value) {
  store.set(key, value);
}

function getAll() {
  return store.store;
}

module.exports = { initSettings, get, set, getAll };
