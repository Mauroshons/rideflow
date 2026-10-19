/**
 * Genera los .gpx de las rutas precargadas a partir de data/route-sources.json.
 *
 *   node tools/build-routes.mjs
 *
 * Las anclas son puntos reales de la carretera; el spline las convierte en
 * una traza con la densidad que espera un simulador (un punto cada 20-30 m)
 * y el perfil se interpola con PCHIP, que no inventa sobre-oscilaciones
 * entre anclas como haría un spline cúbico natural.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { haversine, buildProfile, profileStats } from '../js/geo.js';
import { buildGPX } from '../js/gpx.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Catmull-Rom uniforme; devuelve el punto en t del segmento p1→p2. */
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a, b, c, d) =>
    0.5 *
    (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { lat: f(p0.lat, p1.lat, p2.lat, p3.lat), lon: f(p0.lon, p1.lon, p2.lon, p3.lon) };
}

function densify(anchors, steps = 160) {
  const a = [anchors[0], ...anchors, anchors[anchors.length - 1]];
  const out = [];
  const anchorAt = [];
  for (let i = 1; i < a.length - 2; i++) {
    anchorAt.push(out.length);
    for (let s = 0; s < steps; s++) {
      out.push(catmull(a[i - 1], a[i], a[i + 1], a[i + 2], s / steps));
    }
  }
  anchorAt.push(out.length);
  out.push({ lat: anchors[anchors.length - 1].lat, lon: anchors[anchors.length - 1].lon });
  return { poly: out, anchorAt };
}


/**
 * Desplaza la polilínea lateralmente con una sinusoide para alargarla
 * hasta targetDistance. No es un truco cosmético: los puertos reales
 * ganan su longitud en horquillas, y es esa longitud la que determina
 * la pendiente que el rodillo tiene que reproducir. La amplitud se
 * busca por bisección sobre la longitud resultante.
 */
function applyLacets(poly, target, wavelength) {
  const len = (pts) => {
    let t = 0;
    for (let i = 1; i < pts.length; i++) t += haversine(pts[i - 1], pts[i]);
    return t;
  };
  const base = len(poly);
  if (!target || target <= base * 1.01) return poly;

  // Cuadramos la longitud de onda a un número entero de medios ciclos.
  // Así la sinusoide vale cero justo en los dos extremos y las anclas
  // inicial y final quedan en su sitio sin necesidad de desvanecerla
  // (un desvanecimiento comprime la carretera ahí y dispara la pendiente).
  const halves = Math.max(2, Math.round((2 * base) / wavelength));
  wavelength = (2 * base) / halves;

  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + haversine(poly[i - 1], poly[i]));

  const offsetBy = (amp) =>
    poly.map((pt, i) => {
      const a = poly[Math.max(0, i - 1)];
      const b = poly[Math.min(poly.length - 1, i + 1)];
      const cosLat = Math.cos((pt.lat * Math.PI) / 180);
      let nx = -(b.lat - a.lat);
      let ny = (b.lon - a.lon) * cosLat;
      const n = Math.hypot(nx, ny) || 1;
      nx /= n;
      ny /= n;
      const off = amp * Math.sin((2 * Math.PI * cum[i]) / wavelength);
      return {
        lat: pt.lat + (ny * off) / 111320,
        lon: pt.lon + (nx * off) / (111320 * cosLat),
      };
    });

  let lo = 0;
  let hi = 600;
  let best = poly;
  for (let k = 0; k < 42; k++) {
    const mid = (lo + hi) / 2;
    const candidate = offsetBy(mid);
    const l = len(candidate);
    best = candidate;
    if (l < target) lo = mid;
    else hi = mid;
  }
  return offsetBy((lo + hi) / 2);
}

/** Interpolación cúbica monótona (Fritsch-Carlson). */
function pchip(xs, ys) {
  const n = xs.length;
  const h = [], delta = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    delta.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }
  const d = new Array(n).fill(0);
  d[0] = delta[0];
  d[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) d[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  return (x) => {
    let i = 0;
    while (i < n - 2 && xs[i + 1] < x) i++;
    const s = x - xs[i];
    const hi = h[i];
    const c = (3 * delta[i] - 2 * d[i] - d[i + 1]) / hi;
    const b = (d[i] - 2 * delta[i] + d[i + 1]) / (hi * hi);
    return ys[i] + s * (d[i] + s * (c + s * b));
  };
}

/** Ruido de terreno determinista: suma de senos con fases fijas por id. */
function terrain(seed, amp) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const phase = (k) => ((Math.imul(h, k + 7) >>> 0) % 10000) / 10000 * Math.PI * 2;
  return (x) =>
    amp *
    (0.55 * Math.sin(x / 140 + phase(1)) +
      0.3 * Math.sin(x / 390 + phase(2)) +
      0.15 * Math.sin(x / 73 + phase(3)));
}

const src = JSON.parse(readFileSync(join(root, 'data/route-sources.json'), 'utf8'));
const catalog = [];

for (const r of src.routes) {
  const dense = densify(r.anchors);
  const anchorAt = dense.anchorAt;
  const poly = applyLacets(dense.poly, r.targetDistance, r.lacetWavelength ?? 600);

  // Distancia acumulada sobre la polilínea ya alargada.
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + haversine(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1];

  const eleAt = pchip(
    anchorAt.map((i) => cum[Math.min(i, cum.length - 1)]),
    r.anchors.map((a) => a.ele)
  );
  const noise = terrain(r.id, r.noise ?? 1);

  // Remuestreo a paso fijo por longitud de arco.
  const spacing = r.spacing ?? 25;
  const points = [];
  let j = 0;
  for (let d = 0; d <= total; d += spacing) {
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? (d - cum[j]) / span : 0;
    // El ruido se desvanece en los extremos para respetar las cotas reales.
    const edge = Math.min(1, Math.min(d, total - d) / 400);
    points.push({
      lat: poly[j].lat + (poly[j + 1].lat - poly[j].lat) * t,
      lon: poly[j].lon + (poly[j + 1].lon - poly[j].lon) * t,
      ele: eleAt(d) + noise(d) * edge,
    });
  }
  const last = r.anchors[r.anchors.length - 1];
  points.push({ lat: last.lat, lon: last.lon, ele: last.ele });

  const stats = profileStats(buildProfile(points));
  writeFileSync(
    join(root, 'data/routes', `${r.id}.gpx`),
    buildGPX(r.name, points, { description: r.desc })
  );

  catalog.push({
    id: r.id,
    name: r.name,
    region: r.region,
    desc: r.desc,
    tags: r.tags ?? [],
    file: `data/routes/${r.id}.gpx`,
    distance: Math.round(stats.distance),
    gain: stats.gain,
    maxGrade: Number(stats.maxGrade.toFixed(3)),
    avgGrade: Number(stats.avgGrade.toFixed(4)),
    minEle: stats.minEle,
    maxEle: stats.maxEle,
    points: points.length,
    waypoints: r.anchors.filter((a) => a.wpt).map((a) => ({ name: a.wpt, lat: a.lat, lon: a.lon, ele: a.ele })),
  });

  console.log(
    `${r.id.padEnd(18)} ${(stats.distance / 1000).toFixed(1).padStart(5)} km  ` +
      `+${String(stats.gain).padStart(4)} m  ` +
      `media ${(stats.avgGrade * 100).toFixed(1)}%  max ${(stats.maxGrade * 100).toFixed(1)}%  ` +
      `${points.length} pts`
  );
}

writeFileSync(
  join(root, 'data/routes.json'),
  JSON.stringify({ generated: new Date().toISOString(), routes: catalog }, null, 2)
);
console.log(`\n${catalog.length} rutas escritas en data/routes/ + data/routes.json`);
