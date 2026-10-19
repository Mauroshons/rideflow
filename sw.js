/**
 * Service worker de RideFlow.
 *
 * Objetivo concreto: que la app arranque entera sin red. Esto no es un
 * adorno — el rodillo suele estar en un garaje donde el WiFi llega mal, y
 * una app de entrenamiento que se queda en blanco a mitad de serie no
 * sirve de nada.
 *
 * Estrategia por tipo de recurso:
 *  - El código y los datos de la app: cache primero, red de refuerzo.
 *  - Los azulejos del mapa: red primero con copia en caché, porque son
 *    muchos y no tiene sentido precargarlos.
 */

const VERSION = 'rideflow-v1';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-tiles`;
const MAX_TILES = 600;

const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/geo.js',
  'js/gpx.js',
  'js/physics.js',
  'js/ride.js',
  'js/routes.js',
  'js/store.js',
  'js/trainer/index.js',
  'js/trainer/base.js',
  'js/trainer/protocol.js',
  'js/trainer/ftms.js',
  'js/trainer/tacx.js',
  'js/trainer/bridge.js',
  'js/trainer/sim.js',
  'js/ui/map.js',
  'js/ui/profile.js',
  'data/routes.json',
  'data/routes/farellones.gpx',
  'data/routes/cuesta-barriga.gpx',
  'data/routes/cajon-del-maipo.gpx',
  'data/routes/alpe-dhuez.gpx',
  'data/routes/costanera-concon.gpx',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Uno a uno: si falla un recurso de terceros, addAll aborta el lote
    // entero y la app se queda sin caché por un azulejo cualquiera.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch {
        // Se reintentará sola la próxima vez que se pida por red.
      }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // El puente es WebSocket y las peticiones a la red local no se cachean.
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    event.respondWith(tileStrategy(request));
    return;
  }

  event.respondWith(shellStrategy(request));
});

async function shellStrategy(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) {
    // Refresco en segundo plano: la próxima carga ya trae lo nuevo.
    fetchAndStore(request, SHELL).catch(() => {});
    return cached;
  }
  try {
    return await fetchAndStore(request, SHELL);
  } catch (err) {
    // Navegación sin red y sin copia: devolvemos el documento principal
    // para que la PWA arranque igual.
    if (request.mode === 'navigate') {
      const fallback = await caches.match('index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function tileStrategy(request) {
  const cache = await caches.open(TILES);
  try {
    const res = await fetch(request);
    if (res.ok) {
      cache.put(request, res.clone());
      trimCache(TILES, MAX_TILES);
    }
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function fetchAndStore(request, cacheName) {
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') {
    const cache = await caches.open(cacheName);
    cache.put(request, res.clone());
  }
  return res;
}

/** Los azulejos se acumulan sin límite; se podan por orden de llegada. */
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
}
