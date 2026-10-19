/**
 * Modelo de ciclista virtual.
 *
 * Un rodillo inteligente informa la velocidad de su propio volante, que no
 * tiene nada que ver con la velocidad a la que avanzarías por la carretera
 * que estás simulando. El avance por la ruta se calcula aquí, a partir de
 * la potencia medida y de la pendiente del tramo, igual que hace cualquier
 * simulador serio.
 */

const G = 9.80665;

export const DEFAULT_RIDER = {
  riderKg: 75,
  bikeKg: 8.5,
  crr: 0.004,        // asfalto en buen estado, cubierta de 25-28 mm
  cda: 0.32,         // manos en la parte alta del manillar
  driveEff: 0.975,   // pérdidas de transmisión
  altitude: 0,       // m sobre el nivel del mar, afecta a la densidad del aire
  difficulty: 1.0,   // escala la pendiente enviada al rodillo (trainer difficulty)
};

/** Densidad del aire según altitud, atmósfera estándar. */
export function airDensity(altitudeMeters = 0, celsius = 20) {
  const p = 101325 * Math.pow(1 - 2.25577e-5 * altitudeMeters, 5.25588);
  return p / (287.058 * (celsius + 273.15));
}

/**
 * Avanza un paso de integración.
 * @param {number} v velocidad actual en m/s
 * @param {number} power vatios en la rueda
 * @param {number} grade pendiente como fracción (0.08 = 8%)
 * @param {object} cfg configuración del ciclista
 * @param {number} dt segundos
 * @returns {number} nueva velocidad en m/s
 */
export function step(v, power, grade, cfg, dt) {
  const mass = cfg.riderKg + cfg.bikeKg;
  const rho = airDensity(cfg.altitude ?? 0);
  const theta = Math.atan(grade);

  // Por debajo de ~0.5 m/s el término P/v explota. Se arranca con un
  // empujón acotado en lugar de dejar que la integración diverja.
  const vEff = Math.max(v, 0.5);

  const fPropulsion = (power * (cfg.driveEff ?? 0.975)) / vEff;
  const fGravity = mass * G * Math.sin(theta);
  const fRolling = v > 0.1 ? cfg.crr * mass * G * Math.cos(theta) : 0;
  const fAero = 0.5 * rho * cfg.cda * v * v;

  const a = (fPropulsion - fGravity - fRolling - fAero) / mass;
  let next = v + a * dt;

  // En bajada sin pedalear la bici acelera, pero no indefinidamente:
  // el modelo ya lo limita por aerodinámica. Lo que sí hay que impedir
  // es retroceder cuesta arriba, que no es algo que pase en bici.
  if (next < 0) next = 0;
  return next;
}

/** Velocidad de equilibrio para una potencia y pendiente dadas (m/s). */
export function steadySpeed(power, grade, cfg = DEFAULT_RIDER) {
  let v = 5;
  for (let i = 0; i < 200; i++) v = step(v, power, grade, cfg, 0.25);
  return v;
}

/** Potencia necesaria para mantener una velocidad dada (W). */
export function powerFor(speedMps, grade, cfg = DEFAULT_RIDER) {
  const mass = cfg.riderKg + cfg.bikeKg;
  const rho = airDensity(cfg.altitude ?? 0);
  const theta = Math.atan(grade);
  const f =
    mass * G * Math.sin(theta) +
    cfg.crr * mass * G * Math.cos(theta) +
    0.5 * rho * cfg.cda * speedMps * speedMps;
  return (f * speedMps) / (cfg.driveEff ?? 0.975);
}

/**
 * Zonas de Coggins sobre el FTP. Se usa para colorear la potencia en vivo:
 * leer un número en la pantalla a 100 rpm es más fácil por color que por dígito.
 */
export const ZONES = [
  { key: 'z1', name: 'Recuperación', max: 0.55, color: '#8a9099' },
  { key: 'z2', name: 'Fondo', max: 0.75, color: '#4b9fe1' },
  { key: 'z3', name: 'Tempo', max: 0.9, color: '#3fb27f' },
  { key: 'z4', name: 'Umbral', max: 1.05, color: '#e8c33c' },
  { key: 'z5', name: 'VO2 máx', max: 1.2, color: '#e8863c' },
  { key: 'z6', name: 'Anaeróbico', max: 1.5, color: '#e05252' },
  { key: 'z7', name: 'Neuromuscular', max: Infinity, color: '#b14ad8' },
];

export function zoneFor(power, ftp) {
  if (!ftp || !power) return ZONES[0];
  const r = power / ftp;
  return ZONES.find((z) => r <= z.max) ?? ZONES[ZONES.length - 1];
}

/**
 * Potencia normalizada: media móvil de 30 s elevada a la cuarta.
 * Mide el coste fisiológico real de una sesión con cambios de ritmo.
 */
export function normalizedPower(powerSamples, hz = 1) {
  const win = Math.max(1, Math.round(30 * hz));
  if (powerSamples.length < win) {
    const avg = powerSamples.reduce((a, b) => a + b, 0) / (powerSamples.length || 1);
    return avg;
  }
  let sum = 0;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < powerSamples.length; i++) {
    sum += powerSamples[i];
    if (i >= win) sum -= powerSamples[i - win];
    if (i >= win - 1) {
      acc += (sum / win) ** 4;
      n++;
    }
  }
  return n > 0 ? (acc / n) ** 0.25 : 0;
}
