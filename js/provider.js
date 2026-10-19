/**
 * Proveedor Bluetooth.
 *
 * Reutiliza los mismos adaptadores que la app —FTMS y Tacx FE-C, con su
 * negociación y su codificación de páginas— y en lugar de pintar la
 * telemetría en pantalla, la reenvía al relevo. Las consignas hacen el
 * camino inverso.
 *
 * Es decir: aquí no hay protocolo nuevo. Esta página es la app sin interfaz
 * de rodaje, puesta al servicio de otra pantalla.
 */
import { TrainerManager } from './trainer/index.js';
import { Settings } from './store.js';

const $ = (s) => document.querySelector(s);

const settings = Settings.load();
const trainer = new TrainerManager();
Object.assign(trainer.rider, {
  riderKg: settings.riderKg,
  bikeKg: settings.bikeKg,
  crr: settings.crr,
  cda: settings.cda,
  // La dificultad la aplica el iPad antes de mandar la consigna; si también
  // la aplicara el proveedor, se escalaría dos veces y una rampa del 10 % al
  // 50 % llegaría como un 2,5 %.
  difficulty: 1,
});

let ws = null;
let consumers = 0;
let lastSlope = 0;
let reconnectTimer = null;
let attempt = 0;

/* ------------------------------------------------------------------ *
 *  Relevo
 * ------------------------------------------------------------------ */

function relayUrl() {
  // El relevo escucha en el mismo equipo que sirve esta página.
  const port = new URLSearchParams(location.search).get('bridge') ?? '8787';
  return `ws://${location.hostname}:${port}`;
}

function connectRelay() {
  const url = relayUrl();
  setLink('relay', 'wait', `conectando a ${url}`, 'espera');
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    attempt = 0;
    setLink('relay', 'ok', url, 'listo');
    log(`Relevo conectado en ${url}.`);
    // El hello es lo que nos declara proveedor; sin él, el relevo nos
    // trataría como un consumidor más y no nos mandaría las consignas.
    sendRelay({ type: 'hello', role: 'provider', client: 'rideflow-provider', version: 1 });
    announce();
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleRelayMessage(msg);
  });

  ws.addEventListener('close', () => {
    setLink('relay', 'bad', 'sin conexión con el relevo', 'caído');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => { /* el close que sigue ya informa */ });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(10000, 800 * 2 ** attempt++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, delay);
}

function sendRelay(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleRelayMessage(msg) {
  switch (msg.type) {
    case 'setSlope':
      lastSlope = msg.grade ?? 0;
      $('#vSlope').textContent = (lastSlope * 100).toFixed(1).replace('.', ',');
      // La consigna ya viene escalada por la dificultad del iPad, así que
      // aquí se pasa al rodillo tal cual.
      trainer.adapter?.setSlope(lastSlope, msg.crr ?? 0.004, msg.cw ?? 0.51);
      break;
    case 'setTargetPower':
      trainer.adapter?.setTargetPower(msg.watts ?? 0);
      break;
    case 'setResistance':
      trainer.adapter?.setResistance(msg.percent ?? 0);
      break;
    case 'setRider':
      trainer.adapter?.setRider({ riderKg: msg.riderKg, bikeKg: msg.bikeKg });
      break;
    case 'peers':
      showConsumers(msg.consumers ?? 0);
      break;
    case 'log':
      log(`[relevo] ${msg.message}`);
      break;
    case 'error':
      log(`[relevo] ${msg.message}`, 'error');
      break;
    default:
      break;
  }
}

/** Le dice al relevo si tenemos rodillo y qué sabe hacer. */
function announce() {
  sendRelay({
    type: 'status',
    connected: trainer.connected,
    deviceName: trainer.adapter?.deviceName ?? null,
    supports: trainer.supports,
  });
}

/* ------------------------------------------------------------------ *
 *  Rodillo
 * ------------------------------------------------------------------ */

$('#btnTrainer').addEventListener('click', async () => {
  const btn = $('#btnTrainer');
  btn.disabled = true;
  btn.textContent = 'Conectando…';
  setLink('trainer', 'wait', 'buscando rodillo…', 'espera');
  try {
    // FTMS primero: ya cae solo a FE-C si el rodillo no lo tiene.
    await trainer.connect('ftms', { showAllDevices: $('#showAll').checked });
  } catch (err) {
    setLink('trainer', 'bad', err.message, 'error');
    log(`${err.name}: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Conectar rodillo';
  }
});

$('#btnDisconnect').addEventListener('click', () => trainer.disconnect());

trainer.addEventListener('status', () => {
  const on = trainer.connected;
  $('#btnDisconnect').disabled = !on;
  setLink('trainer', on ? 'ok' : 'bad',
    on ? trainer.adapter.deviceName : 'sin conectar',
    on ? 'conectado' : '—');
  $('#chip').className = `conn-chip ${on ? 'is-on' : 'is-off'}`;
  $('#chipText').textContent = on ? trainer.adapter.deviceName : 'Sin rodillo';
  announce();
});

trainer.addEventListener('data', (e) => {
  const m = e.detail;
  $('#vPower').textContent = Math.round(m.power ?? 0);
  $('#vCadence').textContent = Math.round(m.cadence ?? 0);
  $('#vHr').textContent = m.hr ? Math.round(m.hr) : '—';
  sendRelay({
    type: 'data',
    data: { power: m.power, cadence: m.cadence, hr: m.hr, trainerSpeed: m.trainerSpeed },
  });
});

trainer.addEventListener('log', (e) => {
  log(e.detail.message, e.detail.level);
  sendRelay({ type: 'log', message: e.detail.message, level: e.detail.level });
});

/* ------------------------------------------------------------------ *
 *  Interfaz
 * ------------------------------------------------------------------ */

function setLink(which, state, detail, label) {
  const el = $(`#link${which[0].toUpperCase()}${which.slice(1)}`);
  const detailEl = $(`#${which}Detail`);
  const stateEl = $(`#${which}State`);
  // Sin estas guardas, un id mal escrito en el HTML no se nota como un
  // eslabón que no se pinta, sino como una excepción que se lleva por
  // delante el manejador entero de mensajes del relevo.
  if (el) el.className = `link ${state}`;
  if (detailEl) detailEl.textContent = detail;
  if (stateEl) stateEl.textContent = label;
}

function showConsumers(n) {
  consumers = n;
  setLink('consumers', n > 0 ? 'ok' : 'wait',
    n > 0 ? `${n} conectado${n > 1 ? 's' : ''}` : 'ninguno conectado',
    n > 0 ? 'listo' : 'espera');
}

let logLines = 0;
function log(message, level = 'info') {
  const box = $('#log');
  box.textContent += `[${new Date().toLocaleTimeString('es-CL')}] ${message}\n`;
  if (++logLines > 200) {
    box.textContent = box.textContent.split('\n').slice(-150).join('\n');
    logLines = 150;
  }
  box.scrollTop = box.scrollHeight;
  if (level === 'error') console.error(message);
}

/** Pregunta al servidor sus direcciones de red, para no hacerlas adivinar. */
async function showAddresses() {
  const box = $('#addrList');
  try {
    const res = await fetch('__net');
    if (!res.ok) throw new Error(String(res.status));
    const { addresses, port } = await res.json();
    if (!addresses.length) throw new Error('sin interfaces de red');

    const bridgePort = new URLSearchParams(location.search).get('bridge') ?? '8787';
    const row = (a) => `<div style="margin-bottom:8px${a.likely ? '' : ';opacity:.55'}">
        <code>http://${a.address}:${port}/index.html</code>
        <span class="detail"> — relevo en </span><code>ws://${a.address}:${bridgePort}</code>
        <div class="detail">${a.interface}${a.why ? ` · ${a.why}` : ''}</div>
      </div>`;

    const likely = addresses.filter((a) => a.likely);
    const rest = addresses.filter((a) => !a.likely);
    // Lo probable arriba y sin ruido: las virtuales y las link-local sólo
    // estorban, pero tampoco se ocultan por si la buena fuese una de ellas.
    box.innerHTML =
      likely.map(row).join('') +
      (rest.length
        ? `<details style="margin-top:4px"><summary class="detail" style="cursor:pointer">
             Otras ${rest.length} direcciones de este equipo</summary>
           <div style="margin-top:8px">${rest.map(row).join('')}</div></details>`
        : '');
  } catch {
    box.innerHTML =
      '<span class="detail">No pude leer las direcciones. Mirá las que imprime ' +
      '<code>tools/serve.mjs</code> en la consola.</span>';
  }
}

if (!navigator.bluetooth) {
  setLink('trainer', 'bad', 'este navegador no tiene Web Bluetooth', 'imposible');
  $('#btnTrainer').disabled = true;
  log('Abrí esta página en Chrome o Edge: es la pieza que pone el Bluetooth.', 'error');
}

showAddresses();
connectRelay();
window.provider = { trainer, announce, relayUrl };
