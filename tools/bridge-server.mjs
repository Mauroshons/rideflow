/**
 * Puente RideFlow: pone el Bluetooth donde el iPad no lo tiene.
 *
 *   node tools/bridge-server.mjs [--port 8787] [--backend sim|ble|ant]
 *
 * Safari no implementa Web Bluetooth, así que una PWA en iPad no puede
 * hablar con el rodillo. Este proceso corre en un equipo cercano a la bici
 * —un portátil, una Raspberry Pi— mantiene la conexión con el rodillo y
 * expone un WebSocket en la red local. El iPad manda consignas y recibe
 * telemetría por ahí.
 *
 * El servidor WebSocket está implementado a mano (RFC 6455 es corto si sólo
 * necesitás texto) para que el puente arranque con `node` y nada más. El
 * backend `sim` funciona sin instalar nada; `ble` y `ant` necesitan un
 * paquete opcional cada uno y lo dicen claramente si falta.
 *
 * Protocolo: docs/PUENTE.md
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import {
  fecTrackResistance, fecTargetPower, fecBasicResistance, fecUserConfig,
  antFrame, antUnframe, parseFecPage, UUID,
} from '../js/trainer/protocol.js';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(argOf('port', 8787));
const BACKEND = argOf('backend', 'sim');

/* ------------------------------------------------------------------ *
 *  WebSocket mínimo (sólo texto, sin extensiones)
 * ------------------------------------------------------------------ */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

function accept(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Decodifica tramas de cliente (siempre enmascaradas) desde un búfer. */
function* decodeFrames(buffer) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;

    if (len === 126) {
      if (p + 2 > buffer.length) break;
      len = buffer.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (p + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(p)); p += 8;
    }

    const maskKey = masked ? buffer.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (p + len > buffer.length) break;

    const data = Buffer.from(buffer.subarray(p, p + len));
    if (maskKey) for (let i = 0; i < data.length; i++) data[i] ^= maskKey[i % 4];

    yield { opcode, data };
    offset = p + len;
  }
  return offset;
}

function broadcast(obj) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const sock of clients) {
    if (!sock.destroyed) sock.write(frame);
  }
}

const log = (message, level = 'info') => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  broadcast({ type: 'log', message, level });
};

/* ------------------------------------------------------------------ *
 *  Backends
 * ------------------------------------------------------------------ */

/** Simulación: sirve para verificar el puente sin tocar el rodillo. */
function simBackend() {
  let grade = 0;
  let target = null;
  let power = 0;
  let t = 0;

  const timer = setInterval(() => {
    t += 0.5;
    const want = target ?? 190 * (1 + Math.max(-0.1, grade * 1.5));
    power += (want - power) * 0.25;
    broadcast({
      type: 'data',
      data: {
        power: Math.round(power * (1 + 0.03 * Math.sin(t / 3))),
        cadence: Math.round(90 - Math.max(0, grade) * 160 + 2 * Math.sin(t / 2)),
      },
    });
  }, 500);

  return {
    name: 'Rodillo simulado (puente)',
    supports: { power: true, cadence: true, slope: true, erg: true, resistance: true },
    setSlope: (g) => { grade = g; target = null; },
    setTargetPower: (w) => { target = w > 0 ? w : null; },
    setResistance: (p) => { grade = (p / 100) * 0.15; target = null; },
    setRider: () => {},
    close: () => clearInterval(timer),
  };
}

/**
 * BLE real con @abandonware/noble.
 *   npm install @abandonware/noble
 * Se queda con el servicio FE-C de Tacx, que es el que habla un Flow.
 */
async function bleBackend() {
  let noble;
  try {
    noble = (await import('@abandonware/noble')).default;
  } catch {
    throw new Error(
      'El backend BLE necesita @abandonware/noble. Instalalo con ' +
      '`npm install @abandonware/noble` (en Linux puede hacer falta además ' +
      '`sudo setcap cap_net_raw+eip $(which node)`).'
    );
  }

  const short = (uuid) => uuid.replace(/-/g, '').toLowerCase();
  const FEC_SERVICE = short(UUID.tacxFec);
  const FEC_WRITE = short(UUID.tacxFecWrite);
  const FEC_NOTIFY = short(UUID.tacxFecNotify);

  const peripheral = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      noble.stopScanning();
      reject(new Error('No apareció ningún rodillo Tacx en 30 s. ¿Está encendido y pedaleaste un poco?'));
    }, 30000);

    noble.on('discover', (p) => {
      const name = p.advertisement?.localName ?? '';
      if (/tacx/i.test(name) || p.advertisement?.serviceUuids?.includes(FEC_SERVICE)) {
        clearTimeout(timeout);
        noble.stopScanning();
        resolve(p);
      }
    });

    const start = () => noble.startScanning([], false).catch?.(reject);
    if (noble.state === 'poweredOn') start();
    else noble.on('stateChange', (s) => { if (s === 'poweredOn') start(); });
  });

  log(`Encontrado ${peripheral.advertisement.localName}. Conectando…`);
  await peripheral.connectAsync();

  const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
    [FEC_SERVICE], [FEC_WRITE, FEC_NOTIFY]
  );
  const writeChar = characteristics.find((c) => short(c.uuid) === FEC_WRITE);
  const notifyChar = characteristics.find((c) => short(c.uuid) === FEC_NOTIFY);
  if (!writeChar || !notifyChar) throw new Error('El rodillo no expone las características FE-C esperadas.');

  await notifyChar.subscribeAsync();
  notifyChar.on('data', (buf) => {
    const d = parseFecPage(antUnframe(new Uint8Array(buf)));
    if (!d) return;
    if (d.page === 25) {
      broadcast({ type: 'data', data: { power: d.power ?? undefined, cadence: d.cadence ?? undefined } });
    } else if (d.page === 16) {
      broadcast({ type: 'data', data: { trainerSpeed: d.speed ?? undefined, hr: d.hr ?? undefined } });
    }
  });

  let last = null;
  const send = (page8, remember = true) => {
    if (remember) last = page8;
    return writeChar.writeAsync(Buffer.from(antFrame(page8)), true).catch((e) => {
      log(`Fallo al escribir en el rodillo: ${e.message}`, 'error');
    });
  };
  // FE-C espera la consigna repetida; sin esto algunos firmwares la sueltan.
  const keepalive = setInterval(() => { if (last) send(last, false); }, 1000);

  peripheral.once('disconnect', () => {
    clearInterval(keepalive);
    log('El rodillo se desconectó.', 'warn');
    broadcast({ type: 'status', connected: false });
  });

  return {
    name: peripheral.advertisement.localName ?? 'Tacx',
    supports: { power: true, cadence: true, speed: true, slope: true, erg: true, resistance: true },
    setSlope: (g, crr) => send(fecTrackResistance(g, crr ?? 0.004)),
    setTargetPower: (w) => send(fecTargetPower(w)),
    setResistance: (p) => send(fecBasicResistance(p)),
    setRider: ({ riderKg, bikeKg }) => send(fecUserConfig(riderKg ?? 75, bikeKg ?? 8.5), false),
    close: async () => {
      clearInterval(keepalive);
      await send(fecTrackResistance(0)).catch(() => {});
      await peripheral.disconnectAsync().catch(() => {});
    },
  };
}

/** ANT+ con un palo USB. Es la vía de los Tacx Flow más antiguos. */
async function antBackend() {
  throw new Error(
    'El backend ANT+ necesita un palo USB y el paquete `ant-plus-next`. ' +
    'Está esbozado en docs/PUENTE.md: las páginas FE-C ya están implementadas ' +
    'en js/trainer/protocol.js, sólo falta enchufarlas al canal del palo.'
  );
}

const BACKENDS = { sim: simBackend, ble: bleBackend, ant: antBackend };

/* ------------------------------------------------------------------ *
 *  Arranque
 * ------------------------------------------------------------------ */

let trainer = null;

async function startBackend() {
  const factory = BACKENDS[BACKEND];
  if (!factory) throw new Error(`Backend desconocido: ${BACKEND}. Usá sim, ble o ant.`);
  trainer = await factory();
  log(`Backend "${BACKEND}" listo: ${trainer.name}`);
}

const server = createServer((req, res) => {
  // Un GET normal sirve para comprobar desde el iPad que el puente está vivo.
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    service: 'rideflow-bridge',
    backend: BACKEND,
    connected: !!trainer,
    device: trainer?.name ?? null,
    clients: clients.size,
  }, null, 2));
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);
  socket.id = randomUUID().slice(0, 8);
  clients.add(socket);
  log(`Cliente ${socket.id} conectado (${clients.size} en total).`);

  // Lo primero que necesita la app es saber si hay rodillo al otro lado.
  socket.write(encodeFrame(JSON.stringify({
    type: 'status',
    connected: !!trainer,
    deviceName: trainer?.name ?? null,
    supports: trainer?.supports ?? {},
  })));

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let consumed = 0;
    const it = decodeFrames(buffer);
    let r = it.next();
    while (!r.done) {
      const { opcode, data } = r.value;
      if (opcode === 0x8) {        // close
        socket.end();
        return;
      }
      if (opcode === 0x9) {        // ping -> pong
        socket.write(Buffer.from([0x8a, 0x00]));
      }
      if (opcode === 0x1) handleMessage(socket, data.toString('utf8'));
      r = it.next();
    }
    consumed = r.value ?? 0;
    buffer = buffer.subarray(consumed);
  });

  const drop = () => {
    clients.delete(socket);
    log(`Cliente ${socket.id} desconectado (${clients.size} restantes).`);
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

function handleMessage(socket, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (!trainer) {
    socket.write(encodeFrame(JSON.stringify({ type: 'error', message: 'El puente no tiene rodillo.' })));
    return;
  }
  switch (msg.type) {
    case 'hello':
      break;
    case 'setSlope':
      trainer.setSlope(msg.grade ?? 0, msg.crr, msg.cw);
      break;
    case 'setTargetPower':
      trainer.setTargetPower(msg.watts ?? 0);
      break;
    case 'setResistance':
      trainer.setResistance(msg.percent ?? 0);
      break;
    case 'setRider':
      trainer.setRider({ riderKg: msg.riderKg, bikeKg: msg.bikeKg });
      break;
    case 'disconnect':
      break;
    default:
      socket.write(encodeFrame(JSON.stringify({
        type: 'error', message: `Mensaje no reconocido: ${msg.type}`,
      })));
  }
}

startBackend()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\nPuente RideFlow escuchando en ws://0.0.0.0:${PORT}`);
      console.log('En el iPad: Ajustes → Rodillo → Puente en red local, y poné');
      console.log(`ws://<ip-de-este-equipo>:${PORT}\n`);
    });
  })
  .catch((err) => {
    console.error(`\nNo se pudo arrancar el backend: ${err.message}\n`);
    process.exit(1);
  });

const shutdown = async () => {
  console.log('\nCerrando el puente…');
  await trainer?.close?.();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
