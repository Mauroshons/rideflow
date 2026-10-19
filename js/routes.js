import { parseGPX, buildGPX } from './gpx.js';
import { buildProfile, profileStats, simplify } from './geo.js';
import { Routes as RouteStore } from './store.js';

/**
 * Catálogo de rutas: las cinco que vienen con la app más todo lo que el
 * usuario haya importado o dibujado.
 *
 * Una ruta en memoria es { id, name, region, desc, tags, points, samples,
 * stats, builtIn }. Los puntos se perfilan una sola vez al cargarla.
 */

let builtInIndex = null;

/** Lee data/routes.json, el índice generado por tools/build-routes.mjs. */
export async function loadBuiltInIndex() {
  if (builtInIndex) return builtInIndex;
  const res = await fetch('data/routes.json');
  if (!res.ok) throw new Error('No se pudo leer el catálogo de rutas precargadas.');
  builtInIndex = (await res.json()).routes;
  return builtInIndex;
}

/** Carga el GPX de una ruta precargada y la deja lista para rodar. */
export async function loadBuiltInRoute(id) {
  const index = await loadBuiltInIndex();
  const meta = index.find((r) => r.id === id);
  if (!meta) throw new Error(`Ruta desconocida: ${id}`);

  const res = await fetch(meta.file);
  if (!res.ok) throw new Error(`No se pudo descargar ${meta.file}.`);
  const { points } = parseGPX(await res.text());

  return finalize({
    id: meta.id,
    name: meta.name,
    region: meta.region,
    desc: meta.desc,
    tags: meta.tags,
    waypoints: meta.waypoints ?? [],
    builtIn: true,
    points,
  });
}

/** Importa un GPX que el usuario arrastró o eligió desde Archivos. */
export async function importGPXFile(file) {
  const text = await file.text();
  const parsed = parseGPX(text);
  const name = parsed.name && parsed.name !== 'Ruta importada'
    ? parsed.name
    : file.name.replace(/\.gpx$/i, '');

  const route = finalize({
    id: `user-${Date.now().toString(36)}`,
    name,
    region: 'Importada',
    desc: `Importada desde ${file.name}.`,
    tags: ['importada'],
    waypoints: parsed.waypoints,
    builtIn: false,
    points: parsed.points,
  });

  if (!parsed.hasElevation) {
    route.warning =
      'El GPX no trae altitudes, así que la ruta es completamente llana. ' +
      'Podés usarla igual en modo ERG o resistencia fija.';
  }
  // Guardamos los puntos, no el perfil: se recalcula al abrir, y así un
  // cambio en el suavizado no deja rutas viejas con perfiles rancios.
  await RouteStore.put(serialize(route));
  return route;
}

/** Crea una ruta a partir de puntos dibujados en el mapa. */
export async function createRoute({ name, points, desc = '' }) {
  if (!points || points.length < 2) {
    throw new Error('Hacen falta al menos dos puntos para una ruta.');
  }
  const route = finalize({
    id: `user-${Date.now().toString(36)}`,
    name: name || 'Ruta nueva',
    region: 'Creada en la app',
    desc,
    tags: ['propia'],
    waypoints: [],
    builtIn: false,
    points,
  });
  await RouteStore.put(serialize(route));
  return route;
}

/** Todas las rutas guardadas por el usuario, ya perfiladas. */
export async function loadUserRoutes() {
  const saved = await RouteStore.all();
  return saved.map((r) => finalize({ ...r, builtIn: false }));
}

export async function deleteRoute(id) {
  return RouteStore.remove(id);
}

export function exportRoute(route) {
  return buildGPX(route.name, route.points, { description: route.desc });
}

/* ------------------------------------------------------------------ */

/**
 * Perfila una ruta y la deja con todo lo que la UI necesita.
 * La traza de dibujo se simplifica a 4 m: a esa escala el mapa se ve igual
 * y el canvas del iPad deja de sufrir con rutas de miles de puntos.
 */
function finalize(route) {
  const samples = buildProfile(route.points);
  return {
    ...route,
    samples,
    stats: profileStats(samples),
    drawPoints: simplify(route.points, 4),
  };
}

/** Quita lo derivado antes de guardar: sólo persisten los datos crudos. */
function serialize(route) {
  const { samples, stats, drawPoints, warning, ...rest } = route;
  return {
    ...rest,
    savedAt: Date.now(),
    summary: {
      distance: Math.round(stats.distance),
      gain: stats.gain,
      maxGrade: stats.maxGrade,
    },
  };
}
