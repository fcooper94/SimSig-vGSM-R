const { DEFAULT_SETTINGS } = require('../shared/constants');
const { safeStorage } = require('electron');

let store = null;

function initSettings() {
  const { Conf } = require('electron-conf/main');
  store = new Conf({
    defaults: DEFAULT_SETTINGS,
  });
}

function get(key) {
  // Decrypt password on read
  if (key === 'credentials.password') {
    const encrypted = store.get('credentials._encryptedPassword');
    if (encrypted && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch { return ''; }
    }
    // Fall back to plain text (legacy/migration)
    return store.get('credentials.password') || '';
  }
  return store.get(key);
}

function set(key, value) {
  // Encrypt password on write
  if (key === 'credentials.password') {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value || '').toString('base64');
      store.set('credentials._encryptedPassword', encrypted);
      store.set('credentials.password', ''); // clear plain text
    } else {
      store.set('credentials.password', value);
    }
    return;
  }
  store.set(key, value);
}

function getAll() {
  const all = { ...store.store };
  // Decrypt password for the returned object
  if (all.credentials?._encryptedPassword && safeStorage.isEncryptionAvailable()) {
    try {
      all.credentials.password = safeStorage.decryptString(
        Buffer.from(all.credentials._encryptedPassword, 'base64')
      );
    } catch { all.credentials.password = ''; }
  }
  // Don't expose the encrypted blob to the renderer
  if (all.credentials) delete all.credentials._encryptedPassword;
  return all;
}

module.exports = { initSettings, get, set, getAll };
