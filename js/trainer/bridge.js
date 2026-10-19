import { TrainerAdapter } from './base.js';

/**
 * Adaptador Puente: la respuesta al problema del iPad.
 *
 * Safari no implementa Web Bluetooth y no hay indicios de que vaya a
 * hacerlo, así que una PWA en iPad no puede hablar con el rodillo por sí
 * misma. La salida es poner el Bluetooth donde sí existe: un proceso
 * pequeño en un portátil o una Raspberry Pi al lado de la bici
 * (tools/bridge-server.mjs) mantiene la conexión BLE o el palo ANT+, y el
 * iPad habla con él por WebSocket en la red local.
 *
 * El iPad queda como lo que mejor hace: pantalla y mando. El protocolo del
 * puente es JSON plano y está documentado en docs/PUENTE.md.
 */
export class BridgeAdapter extends TrainerAdapter {
  static id = 'bridge';
  static label = 'Puente en red local';
  static blurb = 'Para iPad: un equipo cercano pone el Bluetooth y el iPad manda por WiFi.';

  static async available() {
    return typeof WebSocket !== 'undefined';
  }

  constructor({ url = null } = {}) {
    super();
    this.url = url ?? localStorage.getItem('rideflow.bridgeUrl') ?? 'ws://rideflow.local:8787';
    this.ws = null;
    this.reconnectTimer = null;
    this.shouldReconnect = false;
    this.attempt = 0;
  }

  connect(url = this.url) {
    this.url = url;
    localStorage.setItem('rideflow.bridgeUrl', url);
    this.shouldReconnect = true;
    return this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(new Error(`Dirección de puente inválida: ${this.url}`));
        return;
      }

      // Si el host no existe, el navegador puede tardar mucho en rendirse.
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { this.ws.close(); } catch { /* ya está */ }
          reject(new Error(`El puente no respondió en ${this.url}. ¿Está corriendo?`));
        }
      }, 6000);

      this.ws.addEventListener('open', () => {
        clearTimeout(timeout);
        this.attempt = 0;
        this.log(`Puente conectado en ${this.url}.`);
        this._send({ type: 'hello', client: 'rideflow', version: 1 });
      });

      this.ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return; // el puente sólo habla JSON; lo que no lo sea, se ignora
        }

        if (msg.type === 'status') {
          Object.assign(this.supports, msg.supports ?? {});
          this.setConnected(!!msg.connected, msg.deviceName ?? 'Puente');
          if (!settled && msg.connected) {
            settled = true;
            resolve(this);
          }
        } else if (msg.type === 'data') {
          this.emitData({ ...msg.data, source: 'bridge' });
        } else if (msg.type === 'log') {
          this.log(`[puente] ${msg.message}`, msg.level ?? 'info');
        } else if (msg.type === 'error') {
          this.log(`[puente] ${msg.message}`, 'error');
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        }
      });

      this.ws.addEventListener('close', () => {
        clearTimeout(timeout);
        this.setConnected(false);
        if (!settled) {
          settled = true;
          reject(new Error(`No se pudo abrir el puente en ${this.url}.`));
        } else if (this.shouldReconnect) {
          this._scheduleReconnect();
        }
      });

      this.ws.addEventListener('error', () => {
        // El evento de error de WebSocket no trae detalle por diseño;
        // el cierre que viene detrás es el que informa de verdad.
      });
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(15000, 1000 * 2 ** this.attempt++);
    this.log(`Reintentando el puente en ${Math.round(delay / 1000)} s…`, 'warn');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open().catch(() => this._scheduleReconnect());
    }, delay);
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async setSlope(grade, crr = 0.004, cw = 0.51) {
    this._send({ type: 'setSlope', grade, crr, cw });
  }

  async setTargetPower(watts) {
    this._send({ type: 'setTargetPower', watts });
  }

  async setResistance(percent) {
    this._send({ type: 'setResistance', percent });
  }

  async setRider(rider) {
    this._send({ type: 'setRider', ...rider });
  }

  async disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._send({ type: 'disconnect' });
    try { this.ws?.close(); } catch { /* ya estaba cerrado */ }
    this.setConnected(false);
  }
}
