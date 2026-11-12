// Tiny IndexedDB persistence layer. Everything is also kept in memory for speed.
const DB_NAME = 'woordje';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  async allCards() {
    return tx('cards', 'readonly', (s) => reqP(s.getAll()));
  },
  async putCard(card) {
    return tx('cards', 'readwrite', (s) => { s.put(card); });
  },
  async putCards(cards) {
    return tx('cards', 'readwrite', (s) => { for (const c of cards) s.put(c); });
  },
  async deleteCard(id) {
    return tx('cards', 'readwrite', (s) => { s.delete(id); });
  },
  async clearCards() {
    return tx('cards', 'readwrite', (s) => { s.clear(); });
  },
  async getMeta(key) {
    return tx('meta', 'readonly', (s) => reqP(s.get(key)));
  },
  async setMeta(key, value) {
    return tx('meta', 'readwrite', (s) => { s.put(value, key); });
  },
};

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (!already) return await navigator.storage.persist();
      return true;
    }
  } catch {}
  return false;
}
