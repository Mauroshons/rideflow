/**
 * Persistencia local.
 *
 * Las rutas importadas y las sesiones grabadas van a IndexedDB, que es lo
 * único con capacidad suficiente en iOS para guardar trazas de veinte mil
 * puntos. Los ajustes van a localStorage, que es más cómodo y pesan nada.
 *
 * Aviso que conviene conocer: en iOS, el almacenamiento de un sitio web se
 * borra tras siete días sin visitarlo. Una PWA añadida a la pantalla de
 * inicio queda exenta de esa purga, así que instalarla no es cosmético.
 */

const DB_NAME = 'rideflow';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('routes')) {
        db.createObjectStore('routes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        s.createIndex('startedAt', 'startedAt');
        s.createIndex('routeId', 'routeId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* --------------------------- rutas del usuario --------------------------- */

export const Routes = {
  async all() {
    return (await tx('routes', 'readonly', (s) => s.getAll())) ?? [];
  },
  async get(id) {
    return tx('routes', 'readonly', (s) => s.get(id));
  },
  async put(route) {
    await tx('routes', 'readwrite', (s) => s.put(route));
    return route;
  },
  async remove(id) {
    return tx('routes', 'readwrite', (s) => s.delete(id));
  },
};

/* --------------------------- sesiones grabadas --------------------------- */

export const Sessions = {
  async all() {
    const list = (await tx('sessions', 'readonly', (s) => s.getAll())) ?? [];
    return list.sort((a, b) => b.startedAt - a.startedAt);
  },
  async add(session) {
    // La traza completa se guarda, pero el listado no la necesita; se lee
    // entera sólo cuando se exporta.
    return tx('sessions', 'readwrite', (s) => s.add(session));
  },
  async get(id) {
    return tx('sessions', 'readonly', (s) => s.get(id));
  },
  async remove(id) {
    return tx('sessions', 'readwrite', (s) => s.delete(id));
  },
};

/* -------------------------------- ajustes -------------------------------- */

const SETTINGS_KEY = 'rideflow.settings';

export const DEFAULT_SETTINGS = {
  riderKg: 75,
  bikeKg: 8.5,
  ftp: 220,
  crr: 0.004,
  cda: 0.32,
  difficulty: 1.0,
  units: 'metric',
  adapter: 'sim',
  bridgeUrl: 'ws://rideflow.local:8787',
  keepAwake: true,
};

export const Settings = {
  load() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  save(patch) {
    const next = { ...this.load(), ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Safari en modo privado lanza al escribir. No es motivo para
      // tumbar la sesión: se sigue con los ajustes en memoria.
    }
    return next;
  },
};

/** Cuánto espacio queda, para avisar antes de que falle una grabación. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota, pct: quota ? usage / quota : 0 };
}

/** Pide almacenamiento persistente; en iOS equivale a instalar la PWA. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
