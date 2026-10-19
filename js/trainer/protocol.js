/**
 * Codificación y decodificación de los dos protocolos que entiende un
 * rodillo Tacx moderno:
 *
 *  - FTMS (Fitness Machine Service, 0x1826), el estándar Bluetooth.
 *  - ANT+ FE-C encapsulado sobre el servicio propietario de Tacx, que es
 *    lo que habla el Flow Smart cuando no expone FTMS.
 *
 * Nada de esto depende del DOM: se puede probar en Node.
 */

/* ------------------------------------------------------------------ *
 *  UUIDs
 * ------------------------------------------------------------------ */

export const UUID = {
  // Estándar
  ftms: 0x1826,
  ftmsIndoorBikeData: 0x2ad2,
  ftmsControlPoint: 0x2ad9,
  ftmsStatus: 0x2ada,
  ftmsFeature: 0x2acc,
  ftmsPowerRange: 0x2ad8,
  ftmsResistanceRange: 0x2ad6,
  cyclingPower: 0x1818,
  cyclingPowerMeasurement: 0x2a63,
  heartRate: 0x180d,
  heartRateMeasurement: 0x2a37,
  deviceInfo: 0x180a,
  // Tacx: FE-C sobre BLE (mismo layout que el UART de Nordic)
  tacxFec: '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e',
  tacxFecWrite: '6e40fec2-b5a3-f393-e0a9-e50e24dcca9e',
  tacxFecNotify: '6e40fec3-b5a3-f393-e0a9-e50e24dcca9e',
};

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ------------------------------------------------------------------ *
 *  FTMS · Indoor Bike Data (0x2AD2)
 * ------------------------------------------------------------------ */

/**
 * El campo de flags usa semántica invertida en el bit 0: "More Data" a 0
 * significa que la velocidad instantánea SÍ viene. Es el error más común
 * al implementar FTMS a mano y deja todos los campos desplazados.
 */
export function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out = {};
  // Lectores acotados: hay firmwares que anuncian campos en los flags y
  // luego mandan el paquete corto. Vale más un campo ausente que una
  // excepción en mitad de una sesión.
  const fits = (n) => o + n <= dv.byteLength;
  const u16 = () => { if (!fits(2)) return undefined; const v = dv.getUint16(o, true); o += 2; return v; };
  const s16 = () => { if (!fits(2)) return undefined; const v = dv.getInt16(o, true); o += 2; return v; };
  const u8 = () => (fits(1) ? dv.getUint8(o++) : undefined);
  const scaled = (v, f) => (v === undefined ? undefined : v * f);

  if (!(flags & 0x0001)) out.speed = scaled(u16(), 1 / 360);   // km/h 0.01 -> m/s
  if (flags & 0x0002) out.avgSpeed = scaled(u16(), 1 / 360);
  if (flags & 0x0004) out.cadence = scaled(u16(), 0.5);        // rpm 0.5
  if (flags & 0x0008) out.avgCadence = scaled(u16(), 0.5);
  if (flags & 0x0010) {
    if (fits(3)) {
      out.distance = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    }
    o += 3;
  }
  if (flags & 0x0020) out.resistance = s16();
  if (flags & 0x0040) out.power = s16();
  if (flags & 0x0080) out.avgPower = s16();
  if (flags & 0x0100) { out.energyTotal = u16(); out.energyPerHour = u16(); out.energyPerMinute = u8(); }
  if (flags & 0x0200) out.hr = u8();
  if (flags & 0x0400) out.met = scaled(u8(), 0.1);
  if (flags & 0x0800) out.elapsed = u16();
  if (flags & 0x1000) out.remaining = u16();
  return out;
}

/** Cycling Power Measurement (0x2A63): potencia y, si viene, cadencia. */
export function parseCyclingPower(dv) {
  const flags = dv.getUint16(0, true);
  const out = { power: dv.getInt16(2, true) };
  let o = 4;
  if (flags & 0x0001) o += 1;               // pedal power balance
  if (flags & 0x0004) o += 2;               // accumulated torque
  if (flags & 0x0010) {                     // wheel revolution data
    out.wheelRevs = dv.getUint32(o, true); o += 4;
    out.wheelTime = dv.getUint16(o, true); o += 2;
  }
  if (flags & 0x0020) {                     // crank revolution data
    out.crankRevs = dv.getUint16(o, true); o += 2;
    out.crankTime = dv.getUint16(o, true); o += 2;
  }
  return out;
}

/** Heart Rate Measurement (0x2A37). */
export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  return { hr: flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1) };
}

/* ------------------------------------------------------------------ *
 *  FTMS · Control Point (0x2AD9)
 * ------------------------------------------------------------------ */

export const FTMS_OP = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetResistance: 0x04,
  setTargetPower: 0x05,
  start: 0x07,
  stop: 0x08,
  setSimulation: 0x11,
};

export const FTMS_RESULT = {
  1: 'ok',
  2: 'no soportado',
  3: 'parámetro inválido',
  4: 'falló',
  5: 'control no permitido',
};

export const ftmsRequestControl = () => Uint8Array.of(FTMS_OP.requestControl);
export const ftmsStart = () => Uint8Array.of(FTMS_OP.start);
export const ftmsStop = () => Uint8Array.of(FTMS_OP.stop, 0x01);

export function ftmsTargetPower(watts) {
  const b = new DataView(new ArrayBuffer(3));
  b.setUint8(0, FTMS_OP.setTargetPower);
  b.setInt16(1, Math.round(clamp(watts, 0, 2000)), true);
  return new Uint8Array(b.buffer);
}

export function ftmsTargetResistance(percent) {
  // La especificación define unidades de 0.1; enviamos décimas, que es lo
  // correcto, aunque buena parte de los rodillos también acepta 0-100 directo.
  const b = new DataView(new ArrayBuffer(2));
  b.setUint8(0, FTMS_OP.setTargetResistance);
  b.setUint8(1, Math.round(clamp(percent, 0, 100) * 10) & 0xff);
  return new Uint8Array(b.buffer);
}

/**
 * Set Indoor Bike Simulation Parameters: el modo pendiente de FTMS.
 * @param {number} grade pendiente como fracción (0.08 = 8%)
 * @param {number} crr coeficiente de rodadura
 * @param {number} cw coeficiente aerodinámico en kg/m
 * @param {number} windMps viento de frente en m/s
 */
export function ftmsSimulation(grade, crr = 0.004, cw = 0.51, windMps = 0) {
  const b = new DataView(new ArrayBuffer(7));
  b.setUint8(0, FTMS_OP.setSimulation);
  b.setInt16(1, Math.round(clamp(windMps, -32, 32) * 1000), true);
  b.setInt16(3, Math.round(clamp(grade, -0.4, 0.4) * 100 * 100), true); // % con resolución 0.01
  b.setUint8(5, Math.round(clamp(crr, 0, 0.0255) / 0.0001));
  b.setUint8(6, Math.round(clamp(cw, 0, 2.55) / 0.01));
  return new Uint8Array(b.buffer);
}

/** Decodifica la indicación de respuesta del control point. */
export function parseControlResponse(dv) {
  if (dv.getUint8(0) !== 0x80) return null;
  const result = dv.getUint8(2);
  return {
    op: dv.getUint8(1),
    result,
    message: FTMS_RESULT[result] ?? 'desconocido',
    ok: result === 1,
  };
}

/** Fitness Machine Feature (0x2ACC): qué sabe hacer este rodillo. */
export function parseFeature(dv) {
  const f = dv.getUint32(0, true);
  const t = dv.byteLength >= 8 ? dv.getUint32(4, true) : 0;
  return {
    cadence: !!(f & (1 << 1)),
    totalDistance: !!(f & (1 << 2)),
    resistanceLevel: !!(f & (1 << 7)),
    heartRate: !!(f & (1 << 10)),
    power: !!(f & (1 << 14)),
    targetResistance: !!(t & (1 << 2)),
    targetPower: !!(t & (1 << 3)),
    simulation: !!(t & (1 << 13)),
    raw: { features: f, targets: t },
  };
}

/* ------------------------------------------------------------------ *
 *  ANT+ FE-C encapsulado (Tacx)
 * ------------------------------------------------------------------ */

const SYNC = 0xa4;
const MSG_BROADCAST = 0x4e;
const MSG_ACK = 0x4f;

/** Checksum ANT: XOR de todos los bytes, sync incluido. */
function antChecksum(bytes) {
  let x = 0;
  for (const b of bytes) x ^= b;
  return x & 0xff;
}

/** Envuelve 8 bytes de pagina FE-C en una trama ANT reconocida. */
export function antFrame(page8, channel = 0, acknowledged = true) {
  if (page8.length !== 8) throw new Error('Una pagina FE-C ocupa exactamente 8 bytes.');
  const head = [SYNC, 0x09, acknowledged ? MSG_ACK : MSG_BROADCAST, channel];
  const body = [...head, ...page8];
  return Uint8Array.from([...body, antChecksum(body)]);
}

/** Extrae los 8 bytes de datos de una trama ANT recibida. */
export function antUnframe(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Algunos firmwares envian la pagina pelada, sin trama.
  if (b.length === 8) return b;
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== SYNC) continue;
    const len = b[i + 1];
    if (i + 3 + len >= b.length) continue;
    const type = b[i + 2];
    if (type !== MSG_BROADCAST && type !== MSG_ACK) continue;
    return b.slice(i + 4, i + 12);
  }
  return null;
}

/** Pagina 48 (0x30) · Resistencia basica. Porcentaje 0-100. */
export function fecBasicResistance(percent) {
  const p = Math.round(clamp(percent, 0, 100) / 0.5);
  return Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, p & 0xff);
}

/** Pagina 49 (0x31) · Potencia objetivo. Resolucion 0.25 W. */
export function fecTargetPower(watts) {
  const v = Math.round(clamp(watts, 0, 4000) / 0.25);
  return Uint8Array.of(0x31, 0xff, 0xff, 0xff, 0xff, 0xff, v & 0xff, (v >> 8) & 0xff);
}

/**
 * Pagina 51 (0x33) · Resistencia de recorrido: la del modo pendiente.
 * El grado lleva offset de -200% con resolucion 0.01%, y la rodadura
 * resolucion 5e-5. Es la pagina que de verdad importa para seguir un GPX.
 */
export function fecTrackResistance(grade, crr = 0.004) {
  const g = Math.round((clamp(grade, -2, 2) * 100 + 200) / 0.01);
  const rr = Math.round(clamp(crr, 0, 0.0127) / 0.00005);
  return Uint8Array.of(0x33, 0xff, 0xff, 0xff, 0xff, g & 0xff, (g >> 8) & 0xff, rr & 0xff);
}

/** Pagina 55 (0x37) · Configuracion de usuario: pesos y rueda. */
export function fecUserConfig(riderKg, bikeKg, wheelMm = 700) {
  const user = Math.round(clamp(riderKg, 0, 655) / 0.01);
  const bike = Math.round(clamp(bikeKg, 0, 50) / 0.05);
  const wheelOffset = 0x0f; // sin offset declarado
  const diameter = Math.round(clamp(wheelMm, 0, 2540) / 10);
  return Uint8Array.of(
    0x37,
    user & 0xff,
    (user >> 8) & 0xff,
    0xff,
    (wheelOffset & 0x0f) | ((bike & 0x0f) << 4),
    (bike >> 4) & 0xff,
    diameter & 0xff,
    0xff
  );
}

/** Pagina 70 (0x46) · Solicitar una pagina concreta al rodillo. */
export function fecRequestPage(page, count = 4) {
  return Uint8Array.of(0x46, 0xff, 0xff, 0xff, 0xff, 0x80, count & 0xff, page & 0xff);
}

const TRAINER_STATE = { 1: 'ASLEEP', 2: 'READY', 3: 'IN_USE', 4: 'FINISHED' };

/** Decodifica las paginas FE-C de datos que nos interesan. */
export function parseFecPage(page8) {
  if (!page8 || page8.length < 8) return null;
  const p = page8[0];

  if (p === 0x10) {
    // Pagina 16 · datos generales del equipo
    const raw = page8[4] | (page8[5] << 8);
    return {
      page: 16,
      elapsed: page8[2] * 0.25,
      distance: page8[3],
      speed: raw === 0xffff ? null : raw * 0.001,
      hr: page8[6] === 0xff ? null : page8[6],
      state: TRAINER_STATE[(page8[7] >> 4) & 0x07] ?? null,
    };
  }

  if (p === 0x19) {
    // Pagina 25 · datos especificos de rodillo
    const inst = page8[5] | ((page8[6] & 0x0f) << 8);
    return {
      page: 25,
      eventCount: page8[1],
      cadence: page8[2] === 0xff ? null : page8[2],
      accumulatedPower: page8[3] | (page8[4] << 8),
      power: inst === 0xfff ? null : inst,
      trainerStatus: (page8[6] >> 4) & 0x0f,
      calibrationNeeded: !!(((page8[6] >> 4) & 0x0f) & 0x01),
      state: TRAINER_STATE[(page8[7] >> 4) & 0x07] ?? null,
    };
  }

  if (p === 0x47) return { page: 71, commandId: page8[1], status: page8[3] };
  if (p === 0x50 || p === 0x51) return { page: p, manufacturer: page8[4] | (page8[5] << 8) };

  return { page: p, raw: Array.from(page8) };
}
