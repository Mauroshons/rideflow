/**
 * Prueba la cadena del relevo sin iPad ni rodillo.
 *
 *   node tools/bridge-server.mjs --port 8788 --backend relay
 *   node tools/check-relay.mjs 8788
 *
 * Levanta dos clientes WebSocket —uno haciendo de proveedor (el Chrome del
 * PC) y otro de consumidor (el iPad)— y comprueba lo que de verdad importa:
 * que la consigna de pendiente llegue del consumidor al proveedor, que la
 * telemetría haga el camino inverso, y que si el proveedor se cae el
 * consumidor se entere en lugar de quedarse mirando vatios congelados.
 */
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const PORT = Number(process.argv[2] ?? 8788);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'OK  ' : 'FALLA'} ${name}${extra ? '  ' + extra : ''}`);
};

/** Cliente WebSocket mínimo: handshake, enmascarado y decodificación. */
function client(label) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const sock = connect(PORT, '127.0.0.1', () => {
      sock.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    const api = { label, received: [], sock };
    let buffer = Buffer.alloc(0);
    let upgraded = false;

    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString();
        const expect = createHash('sha1').update(key + GUID).digest('base64');
        if (!head.includes(expect)) { reject(new Error(`${label}: handshake inválido`)); return; }
        upgraded = true;
        buffer = buffer.subarray(end + 4);
        resolve(api);
      }
      while (buffer.length >= 2) {
        let len = buffer[1] & 0x7f;
        let p = 2;
        if (len === 126) { if (buffer.length < 4) break; len = buffer.readUInt16BE(2); p = 4; }
        if (p + len > buffer.length) break;
        const payload = buffer.subarray(p, p + len).toString();
        buffer = buffer.subarray(p + len);
        try { api.received.push(JSON.parse(payload)); } catch { /* no es JSON */ }
      }
    });

    sock.on('error', reject);

    api.send = (obj) => {
      const payload = Buffer.from(JSON.stringify(obj));
      const mask = randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      const header = payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : (() => { const h = Buffer.alloc(8); h[0] = 0x81; h[1] = 0xfe; h.writeUInt16BE(payload.length, 2); return h.subarray(0, 4); })();
      sock.write(Buffer.concat([header, mask, masked]));
    };
    api.last = (type) => [...api.received].reverse().find((m) => m.type === type);
    api.clear = () => { api.received.length = 0; };
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const provider = await client('proveedor');
const consumer = await client('consumidor');
await wait(200);

// Sin proveedor declarado, el consumidor no debe creerse conectado.
ok('consumidor sin proveedor: no conectado', consumer.last('status')?.connected === false,
   JSON.stringify(consumer.last('status')));

provider.send({ type: 'hello', role: 'provider', client: 'test', version: 1 });
await wait(200);

// Declarado pero sin rodillo todavía: sigue sin haber nada al otro lado.
ok('proveedor sin rodillo: sigue no conectado', consumer.last('status')?.connected === false);

provider.send({ type: 'status', connected: true, deviceName: 'Tacx Flow 01234',
                supports: { power: true, cadence: true, slope: true, erg: true } });
await wait(250);

const st = consumer.last('status');
ok('el consumidor ve el rodillo', st?.connected === true && st?.deviceName === 'Tacx Flow 01234',
   `${st?.deviceName}`);
ok('y ve lo que sabe hacer', st?.supports?.slope === true && st?.supports?.erg === true);

// Consigna del iPad hacia el rodillo.
provider.clear();
consumer.send({ type: 'setSlope', grade: 0.074, crr: 0.004, cw: 0.51 });
await wait(250);
const slope = provider.last('setSlope');
ok('la pendiente llega al proveedor', slope?.grade === 0.074, JSON.stringify(slope));

consumer.send({ type: 'setTargetPower', watts: 265 });
await wait(200);
ok('la potencia objetivo llega al proveedor', provider.last('setTargetPower')?.watts === 265);

// Telemetría del rodillo hacia el iPad.
consumer.clear();
provider.send({ type: 'data', data: { power: 243, cadence: 88, hr: 151 } });
await wait(250);
const data = consumer.last('data');
ok('la telemetría llega al iPad', data?.data?.power === 243 && data?.data?.cadence === 88,
   JSON.stringify(data?.data));

// El proveedor no debe recibir de vuelta su propia telemetría.
ok('el proveedor no se oye a sí mismo', provider.last('data') === undefined);

// Y si el proveedor se cae, el iPad tiene que enterarse.
consumer.clear();
provider.sock.destroy();
await wait(400);
ok('al caer el proveedor, el iPad lo sabe', consumer.last('status')?.connected === false,
   JSON.stringify(consumer.last('status')));

consumer.sock.destroy();
console.log(fails === 0 ? '\nLa cadena del relevo está entera.' : `\n${fails} prueba(s) fallidas.`);
process.exit(fails === 0 ? 0 : 1);
