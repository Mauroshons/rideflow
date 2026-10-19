import { FtmsAdapter } from './ftms.js';
import { TacxFecAdapter } from './tacx.js';
import { BridgeAdapter } from './bridge.js';
import { SimAdapter } from './sim.js';
import { DEFAULT_RIDER } from '../physics.js';

export const ADAPTERS = [FtmsAdapter, TacxFecAdapter, BridgeAdapter, SimAdapter];

/**
 * Capa única entre la app y el rodillo, sea cual sea.
 *
 * Además de enrutar, hace tres cosas que ningún adaptador debería tener que
 * repetir: limitar el ritmo de escritura (un BLE no aguanta diez consignas
 * por segundo), escalar la pendiente según la dificultad elegida, y marcar
 * la telemetría como rancia cuando el aparato deja de hablar.
 */
export class TrainerManager extends EventTarget {
  constructor() {
    super();
    this.adapter = null;
    this.rider = { ...DEFAULT_RIDER };
    this.mode = 'slope';              // 'slope' | 'erg' | 'resistance'
    this.metrics = { power: 0, cadence: 0, hr: 0, trainerSpeed: 0, stale: true };
    this.logs = [];

    // Control de ritmo de escritura.
    this._lastSlopeSent = null;
    this._lastSlopeAt = 0;
    this._pendingSlope = null;
    this._minIntervalMs = 300;
    this._flushTimer = null;

    this._lastDataAt = 0;
    this._staleTimer = setInterval(() => this._checkStale(), 1000);
  }

  get connected() {
    return !!this.adapter?.connected;
  }

  get supports() {
    return this.adapter?.supports ?? {};
  }

  static async availability() {
    const out = {};
    for (const A of ADAPTERS) out[A.id] = await A.available();
    return out;
  }

  /** Conecta usando el adaptador indicado, desconectando el anterior. */
  async connect(adapterId, options = {}) {
    const Adapter = ADAPTERS.find((a) => a.id === adapterId);
    if (!Adapter) throw new Error(`Adaptador desconocido: ${adapterId}`);

    if (this.adapter) await this.disconnect();

    const adapter = new Adapter(options);
    adapter.addEventListener('data', (e) => this._onData(e.detail));
    adapter.addEventListener('log', (e) => this._onLog(e.detail));
    adapter.addEventListener('status', (e) => {
      this.dispatchEvent(new CustomEvent('status', { detail: e.detail }));
    });

    this.adapter = adapter;
    try {
      await adapter.connect(options.url);
    } catch (err) {
      this.adapter = null;
      throw err;
    }

    await adapter.setRider({ riderKg: this.rider.riderKg, bikeKg: this.rider.bikeKg });
    // Reiniciar el estado de ritmo: el rodillo nuevo no sabe nada del anterior.
    this._lastSlopeSent = null;
    return adapter;
  }

  async disconnect() {
    if (!this.adapter) return;
    const a = this.adapter;
    this.adapter = null;
    await a.disconnect().catch(() => {});
    this.metrics = { power: 0, cadence: 0, hr: 0, trainerSpeed: 0, stale: true };
    this.dispatchEvent(new CustomEvent('status', { detail: { connected: false } }));
  }

  setRider(patch) {
    Object.assign(this.rider, patch);
    this.adapter?.setRider({
      riderKg: this.rider.riderKg,
      bikeKg: this.rider.bikeKg,
    });
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'erg') this.adapter?.setTargetPower?.(0);
    this.dispatchEvent(new CustomEvent('mode', { detail: mode }));
  }

  /* ---------------------------------------------------------------- *
   *  Consigna de pendiente
   * ---------------------------------------------------------------- */

  /**
   * Pide una pendiente. Lo que llega al rodillo pasa antes por el factor de
   * dificultad: al 50%, una rampa del 10% se siente como un 5%, que es el
   * ajuste que casi todo el mundo necesita para no quedarse clavado en un
   * puerto de verdad con el desarrollo de una bici de carretera.
   */
  requestSlope(grade) {
    if (this.mode !== 'slope') return;
    const scaled = grade * (this.rider.difficulty ?? 1);
    this._pendingSlope = scaled;
    this._flushSlope();
  }

  _flushSlope() {
    if (this._pendingSlope === null || !this.adapter) return;
    const now = Date.now();
    const since = now - this._lastSlopeAt;

    // Nada que decir si el cambio es irrelevante: ahorra radio y evita que
    // el rodillo esté recalculando la curva de freno sin parar.
    const delta =
      this._lastSlopeSent === null ? Infinity : Math.abs(this._pendingSlope - this._lastSlopeSent);
    if (delta < 0.002 && since < 3000) {
      this._pendingSlope = null;
      return;
    }

    if (since < this._minIntervalMs) {
      if (!this._flushTimer) {
        this._flushTimer = setTimeout(() => {
          this._flushTimer = null;
          this._flushSlope();
        }, this._minIntervalMs - since);
      }
      return;
    }

    const grade = this._pendingSlope;
    this._pendingSlope = null;
    this._lastSlopeSent = grade;
    this._lastSlopeAt = now;

    // cw = 0.5 * rho * CdA, que es lo que esperan tanto FTMS como FE-C.
    const cw = 0.5 * 1.225 * this.rider.cda;
    this.adapter.setSlope(grade, this.rider.crr, cw).catch((e) => {
      this._onLog({ message: `No se pudo fijar la pendiente: ${e.message}`, level: 'error' });
    });
    this.dispatchEvent(new CustomEvent('slope', { detail: { grade } }));
  }

  async setTargetPower(watts) {
    await this.adapter?.setTargetPower(watts);
    this.dispatchEvent(new CustomEvent('target', { detail: { watts } }));
  }

  async setResistance(percent) {
    await this.adapter?.setResistance(percent);
  }

  /** Sólo tiene efecto sobre el simulador. */
  setSimEffort(fraction) {
    if (this.adapter instanceof SimAdapter) this.adapter.setEffort(fraction);
  }

  /* ---------------------------------------------------------------- *
   *  Telemetría
   * ---------------------------------------------------------------- */

  _onData(d) {
    this._lastDataAt = Date.now();
    // Las muestras llegan parciales: la banda manda pulso, el rodillo manda
    // potencia. Se fusionan en lugar de pisarse.
    for (const k of ['power', 'cadence', 'hr', 'trainerSpeed']) {
      if (d[k] !== undefined && d[k] !== null && Number.isFinite(d[k])) this.metrics[k] = d[k];
    }
    this.metrics.stale = false;
    this.dispatchEvent(new CustomEvent('data', { detail: this.metrics }));
  }

  _checkStale() {
    if (!this.connected) return;
    const quiet = Date.now() - this._lastDataAt;
    if (quiet > 4000 && !this.metrics.stale) {
      this.metrics.stale = true;
      this.metrics.power = 0;
      this.metrics.cadence = 0;
      this._onLog({ message: 'Sin datos del rodillo desde hace 4 s.', level: 'warn' });
      this.dispatchEvent(new CustomEvent('data', { detail: this.metrics }));
    }
  }

  _onLog(entry) {
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.shift();
    this.dispatchEvent(new CustomEvent('log', { detail: entry }));
  }

  destroy() {
    clearInterval(this._staleTimer);
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this.disconnect();
  }
}
