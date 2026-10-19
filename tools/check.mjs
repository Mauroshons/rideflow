/**
 * Pruebas rápidas de los módulos puros (sin DOM). node tools/check.mjs
 */
import * as P from '../js/trainer/protocol.js';
import * as Phys from '../js/physics.js';
import { buildProfile, profileStats, sampleAt, simplify, haversine } from '../js/geo.js';

let fails = 0;
const hex = (u) => Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join(' ');
function ok(name, cond, extra = '') {
  if (!cond) fails++;
  console.log(`${cond ? 'OK  ' : 'FALLA'} ${name}${extra ? '  ' + extra : ''}`);
}

// --- FE-C -----------------------------------------------------------------
const track8 = P.fecTrackResistance(0.08);
// 8% -> (8 + 200) / 0.01 = 20800 = 0x5140
ok('FE-C p51 pendiente 8%', track8[5] === 0x40 && track8[6] === 0x51, hex(track8));
const trackNeg = P.fecTrackResistance(-0.05);
// -5% -> (195) / 0.01 = 19500 = 0x4C2C
ok('FE-C p51 pendiente -5%', trackNeg[5] === 0x2c && trackNeg[6] === 0x4c, hex(trackNeg));
const tp = P.fecTargetPower(250); // 250 / 0.25 = 1000 = 0x03E8
ok('FE-C p49 potencia 250 W', tp[6] === 0xe8 && tp[7] === 0x03, hex(tp));

const frame = P.antFrame(P.fecTargetPower(200));
let x = 0;
for (const b of frame.slice(0, -1)) x ^= b;
ok('trama ANT: checksum', frame[frame.length - 1] === x, hex(frame));
ok('trama ANT: ida y vuelta', hex(P.antUnframe(frame)) === hex(P.fecTargetPower(200)));

const p25 = P.parseFecPage(Uint8Array.of(0x19, 12, 90, 0x10, 0x00, 0xf4, 0x01, 0x30));
ok('FE-C p25 decodificada', p25.cadence === 90 && p25.power === 500 && p25.state === 'IN_USE',
   JSON.stringify({ cad: p25.cadence, w: p25.power, st: p25.state }));

// --- FTMS -----------------------------------------------------------------
const sim = P.ftmsSimulation(0.08);
const simDv = new DataView(sim.buffer);
ok('FTMS 0x11 pendiente 8%', simDv.getInt16(3, true) === 800, String(simDv.getInt16(3, true)));
ok('FTMS 0x05 potencia', new DataView(P.ftmsTargetPower(250).buffer).getInt16(1, true) === 250);

// Indoor Bike Data: bit0 a 0 = velocidad instantánea presente; bit6 = potencia
const ibd = new DataView(new ArrayBuffer(6));
ibd.setUint16(0, 0x0040, true);
ibd.setUint16(2, 3000, true);   // 30.00 km/h
ibd.setInt16(4, 231, true);     // 231 W
const parsed = P.parseIndoorBikeData(ibd);
ok('FTMS 0x2AD2 paquete truncado no revienta', (() => {
  const t = new DataView(new ArrayBuffer(4));
  t.setUint16(0, 0x0040, true);
  try { P.parseIndoorBikeData(t); return true; } catch { return false; }
})());
ok('FTMS 0x2AD2 velocidad + potencia',
   Math.abs(parsed.speed * 3.6 - 30) < 0.01 && parsed.power === 231,
   `${(parsed.speed * 3.6).toFixed(1)} km/h, ${parsed.power} W`);

// --- Física ---------------------------------------------------------------
const cfg = { ...Phys.DEFAULT_RIDER, riderKg: 75, bikeKg: 8 };
const flat = Phys.steadySpeed(250, 0, cfg) * 3.6;
const climb = Phys.steadySpeed(250, 0.08, cfg) * 3.6;
// 250 W en posición de manos arriba (CdA 0.32) dan 36-38 km/h en llano.
// Para 40+ hace falta bajar a ~0.25 de CdA, que ya es posición aero.
ok('250 W en llano ~ 35-39 km/h', flat > 35 && flat < 39, `${flat.toFixed(1)} km/h`);
ok('250 W al 8% ~ 10-13 km/h', climb > 9.5 && climb < 13.5, `${climb.toFixed(1)} km/h`);
const rt = Phys.powerFor(Phys.steadySpeed(300, 0.06, cfg), 0.06, cfg);
ok('powerFor invierte steadySpeed', Math.abs(rt - 300) < 5, `${rt.toFixed(0)} W`);
ok('NP >= media con cambios de ritmo',
   Phys.normalizedPower([100, 400, 100, 400].flatMap((p) => Array(30).fill(p))) > 250);

// --- Geo ------------------------------------------------------------------
// Un grado de latitud son ~111.2 km
ok('haversine 1 grado de latitud',
   Math.abs(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111195) < 200);

const ramp = Array.from({ length: 200 }, (_, i) => ({
  lat: -33.4 + i * 0.0002, lon: -70.6, ele: 500 + i * 2,
}));
const prof = buildProfile(ramp);
const st = profileStats(prof);
ok('perfil: desnivel acumulado', Math.abs(st.gain - 398) < 10, `+${st.gain} m`);
ok('perfil: pendiente media coherente', st.avgGrade > 0.08 && st.avgGrade < 0.12,
   `${(st.avgGrade * 100).toFixed(1)}%`);
// Regresión: el suavizado no debe inventar pendiente donde no la hay.
// Una rampa perfectamente regular, con los bordes de la ventana cayendo
// justo sobre las muestras, llegó a dar picos del 13,8 % sobre un 10,4 %
// real porque la ventana alternaba entre 6 y 7 puntos.
const clean = Array.from({ length: 400 }, (_, i) => ({
  lat: 45 + i * 0.00018, lon: 6, ele: 700 + i * 2.08,
}));
const cleanStats = profileStats(buildProfile(clean));
ok('el suavizado no inventa rampas', cleanStats.maxGrade < cleanStats.avgGrade * 1.06,
   `max ${(cleanStats.maxGrade * 100).toFixed(1)}% vs media ${(cleanStats.avgGrade * 100).toFixed(1)}%`);

const mid = sampleAt(prof, st.distance / 2);
ok('sampleAt a mitad de ruta', Math.abs(mid.dTotal - st.distance / 2) < 1 && mid.ele > 500);
ok('sampleAt satura al final', sampleAt(prof, st.distance * 2).done === true);
ok('simplify reduce una recta', simplify(ramp, 5).length < 10, `${simplify(ramp, 5).length} pts`);

console.log(fails === 0 ? '\nTodo en verde.' : `\n${fails} prueba(s) fallidas.`);
process.exit(fails === 0 ? 0 : 1);
