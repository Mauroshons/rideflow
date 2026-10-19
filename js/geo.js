/**
 * Geodesia y perfilado de rutas.
 * Todo trabaja sobre "puntos": { lat, lon, ele, time? }
 * y devuelve "muestras": punto + { d, dTotal, grade, slope }
 */

const R = 6371008.8; // radio medio terrestre WGS84, en metros
const rad = (deg) => (deg * Math.PI) / 180;

/** Distancia haversine en metros entre dos puntos. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const la1 = rad(a.lat);
  const la2 = rad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rumbo inicial en grados (0 = norte) de a hacia b. */
export function bearing(a, b) {
  const la1 = rad(a.lat);
  const la2 = rad(b.lat);
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * Media móvil sobre la altitud. Los GPS baratos y la mayoría de los
 * exportadores dejan ruido de +-3 m que, derivado, produce rampas
 * fantasma del 20%. Sin esto el rodillo pega tirones absurdos.
 */
export function smoothElevation(points, windowMeters = 120) {
  const n = points.length;
  if (n < 3) return points.map((p) => p.ele ?? 0);
  const cum = cumulativeDistance(points);

  // Sumas de prefijo: cualquier media de un rango sale en tiempo constante.
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (points[i].ele ?? 0);

  const half = windowMeters / 2;
  const out = new Array(n);

  for (let i = 0; i < n; i++) {
    // La ventana tiene que ser simétrica EN NÚMERO DE PUNTOS, no sólo en
    // distancia. Con puntos regularmente espaciados, los bordes caen justo
    // encima de una muestra y el redondeo decide si entra o no; eso hace que
    // la ventana alterne entre 6 y 7 puntos y que la media oscile. Sobre una
    // rampa limpia, ese diente de sierra se deriva como rampas del 13 % que
    // no existen: el suavizado acababa inventando justo el ruido que venía
    // a quitar.
    let k = 0;
    while (
      i - k - 1 >= 0 &&
      i + k + 1 < n &&
      cum[i] - cum[i - k - 1] <= half &&
      cum[i + k + 1] - cum[i] <= half
    ) {
      k++;
    }
    out[i] = (pre[i + k + 1] - pre[i - k]) / (2 * k + 1);
  }
  return out;
}

/** Distancia acumulada (m) para cada punto. */
export function cumulativeDistance(points) {
  const cum = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + haversine(points[i - 1], points[i]);
  }
  return cum;
}

/**
 * Construye el perfil completo de una ruta: distancias acumuladas,
 * altitud suavizada y pendiente por tramo (fracción, no porcentaje).
 */
export function buildProfile(points, { smoothing = 120, gradeWindow = 60 } = {}) {
  const clean = points.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
  );
  if (clean.length < 2) {
    throw new Error('La ruta necesita al menos dos puntos válidos.');
  }
  const dTotalArr = cumulativeDistance(clean);
  const ele = smoothElevation(clean, smoothing);

  const samples = clean.map((p, i) => ({
    lat: p.lat,
    lon: p.lon,
    ele: ele[i],
    eleRaw: p.ele ?? 0,
    time: p.time ?? null,
    dTotal: dTotalArr[i],
    d: i === 0 ? 0 : dTotalArr[i] - dTotalArr[i - 1],
    grade: 0,
  }));

  // Pendiente con ventana mínima: comparar sólo puntos consecutivos
  // amplifica el ruido residual. Miramos hacia adelante gradWindow metros.
  for (let i = 0; i < samples.length; i++) {
    let j = i;
    while (j < samples.length - 1 && samples[j].dTotal - samples[i].dTotal < gradeWindow) j++;
    const run = samples[j].dTotal - samples[i].dTotal;
    samples[i].grade = run > 1 ? (samples[j].ele - samples[i].ele) / run : 0;
    if (!Number.isFinite(samples[i].grade)) samples[i].grade = 0;
    samples[i].grade = Math.max(-0.3, Math.min(0.3, samples[i].grade));
  }
  if (samples.length > 1) samples[samples.length - 1].grade = samples[samples.length - 2].grade;

  return samples;
}

/** Estadísticas agregadas de un perfil. */
export function profileStats(samples) {
  let gain = 0;
  let loss = 0;
  let maxGrade = 0;
  let minEle = Infinity;
  let maxEle = -Infinity;
  for (let i = 1; i < samples.length; i++) {
    const dz = samples[i].ele - samples[i - 1].ele;
    if (dz > 0) gain += dz;
    else loss -= dz;
    if (samples[i].grade > maxGrade) maxGrade = samples[i].grade;
    minEle = Math.min(minEle, samples[i].ele);
    maxEle = Math.max(maxEle, samples[i].ele);
  }
  const distance = samples[samples.length - 1].dTotal;
  return {
    distance,
    gain: Math.round(gain),
    loss: Math.round(loss),
    maxGrade,
    minEle: Math.round(minEle),
    maxEle: Math.round(maxEle),
    avgGrade: distance > 0 ? gain / distance : 0,
  };
}

/**
 * Interpola la posición y la pendiente a una distancia dada.
 * Es el corazón del modo "ride": el avance virtual se mide en metros,
 * no en índices de punto.
 */
export function sampleAt(samples, meters) {
  const total = samples[samples.length - 1].dTotal;
  const m = Math.max(0, Math.min(total, meters));
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].dTotal <= m) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.dTotal - a.dTotal;
  const t = span > 0 ? (m - a.dTotal) / span : 0;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    ele: a.ele + (b.ele - a.ele) * t,
    grade: a.grade + (b.grade - a.grade) * t,
    dTotal: m,
    index: lo,
    done: m >= total - 0.5,
  };
}

/** Bounding box [[south, west], [north, east]] para encuadrar el mapa. */
export function bounds(points) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of points) {
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
  }
  return [[s, w], [n, e]];
}

/**
 * Simplificación Douglas-Peucker en el plano local. Una ruta de 20 000
 * puntos mata al canvas del iPad; 2 000 se ven idénticos.
 */
export function simplify(points, toleranceMeters = 5) {
  if (points.length < 3) return points.slice();
  const lat0 = rad(points[0].lat);
  const mx = (p) => rad(p.lon) * Math.cos(lat0) * R;
  const my = (p) => rad(p.lat) * R;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let idx = -1;
    const ax = mx(points[first]), ay = my(points[first]);
    const bx = mx(points[last]), by = my(points[last]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const px = mx(points[i]), py = my(points[i]);
      let dist;
      if (len2 === 0) {
        dist = Math.hypot(px - ax, py - ay);
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (dist > maxDist) {
        maxDist = dist;
        idx = i;
      }
    }
    if (maxDist > toleranceMeters && idx > 0) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export const fmt = {
  km: (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1),
  pct: (g) => (g * 100).toFixed(1),
  hhmmss: (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  },
  speed: (mps) => (mps * 3.6).toFixed(1),
};
