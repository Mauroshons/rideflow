import { TrainerAdapter, WriteQueue } from './base.js';
import { FecChannel, requestOptions } from './tacx.js';
import * as P from './protocol.js';

/**
 * Adaptador FTMS: el estándar Bluetooth de máquinas de fitness.
 *
 * Es la vía preferente con cualquier rodillo moderno, incluidos los Tacx
 * con firmware reciente. Si el aparato no expone 0x1826 se cae a Cycling
 * Power (0x1818), que da potencia y cadencia pero no permite controlar
 * la resistencia: ahí la app sigue sirviendo como medidor.
 */
export class FtmsAdapter extends TrainerAdapter {
  static id = 'ftms';
  static label = 'Rodillo Bluetooth (FTMS)';
  static blurb = 'Estándar abierto. Tacx Flow/Flux con firmware reciente, Wahoo, Elite, Saris.';

  static async available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  constructor({ showAllDevices = false } = {}) {
    super();
    this.device = null;
    this.server = null;
    this.cp = null;             // control point
    this.queue = new WriteQueue();
    this.hasControl = false;
    this.showAllDevices = showAllDevices;
    this.fec = null;            // relleno sólo si el rodillo resulta ser FE-C
    this._onDisconnect = () => {
      this.fec?.stopKeepalive();
      this.log('El rodillo se desconectó.', 'warn');
      this.setConnected(false);
    };
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error(
        'Este navegador no expone Web Bluetooth. En iPad usá el modo Puente o el Simulador.'
      );
    }

    this.device = await navigator.bluetooth.requestDevice(
      requestOptions(this.showAllDevices, [P.UUID.ftms])
    );

    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    this.server = await this.device.gatt.connect();
    this.log(`Conectado a ${this.device.name ?? 'rodillo'}.`);

    // Orden de preferencia: FTMS, luego el FE-C de Tacx, y como último
    // recurso Cycling Power en modo sólo-medición. Antes, un Flow sin FTMS
    // acababa en Cycling Power y había que volver a Ajustes a cambiar de
    // adaptador a mano; ahora se resuelve en la misma conexión.
    const ftms = await this.server.getPrimaryService(P.UUID.ftms).catch(() => null);
    if (ftms) {
      await this._setupFtms(ftms);
    } else {
      const fecService = await this.server.getPrimaryService(P.UUID.tacxFec).catch(() => null);
      if (fecService) await this._setupFec(fecService);
      else await this._setupPowerOnly();
    }

    await this._setupHeartRate();
    this.setConnected(true, this.device.name ?? 'Rodillo');
    return this;
  }

  /** El rodillo no tiene FTMS pero sí el servicio FE-C de Tacx. */
  async _setupFec(service) {
    this.log('Sin FTMS, pero habla FE-C de Tacx. Sigo por ahí.');
    this.fec = new FecChannel({
      onData: (d) => this.emitData(d),
      onLog: (m, l) => this.log(m, l),
    });
    await this.fec.attach(service, () => !!this.device?.gatt?.connected);
    Object.assign(this.supports, {
      power: true, cadence: true, speed: true, slope: true, erg: true, resistance: true,
    });
    await this.fec.setSlope(0);
    this.fec.startKeepalive();
  }

  async _setupFtms(service) {
    // Qué sabe hacer. Si el aparato no publica la característica de
    // features asumimos lo habitual en lugar de rendirnos.
    try {
      const feat = await service.getCharacteristic(P.UUID.ftmsFeature);
      const f = P.parseFeature(await feat.readValue());
      Object.assign(this.supports, {
        power: f.power,
        cadence: f.cadence,
        speed: true,
        slope: f.simulation,
        erg: f.targetPower,
        resistance: f.targetResistance,
      });
      this.log(
        `Capacidades FTMS: ${[
          f.simulation && 'pendiente',
          f.targetPower && 'ERG',
          f.targetResistance && 'resistencia',
        ].filter(Boolean).join(', ') || 'sólo lectura'}.`
      );
    } catch {
      Object.assign(this.supports, {
        power: true, cadence: true, speed: true, slope: true, erg: true, resistance: true,
      });
      this.log('El rodillo no publica sus capacidades; asumo FTMS completo.', 'warn');
    }

    // Rango de potencia admitido, para no pedir ERG fuera de márgenes.
    try {
      const range = await service.getCharacteristic(P.UUID.ftmsPowerRange);
      const dv = await range.readValue();
      this.powerRange = {
        min: dv.getInt16(0, true),
        max: dv.getInt16(2, true),
        step: dv.getUint16(4, true),
      };
    } catch { /* opcional */ }

    const data = await service.getCharacteristic(P.UUID.ftmsIndoorBikeData);
    await data.startNotifications();
    data.addEventListener('characteristicvaluechanged', (e) => {
      const d = P.parseIndoorBikeData(e.target.value);
      this.emitData({
        power: d.power,
        cadence: d.cadence,
        trainerSpeed: d.speed,
        hr: d.hr,
        source: 'ftms',
      });
    });

    this.cp = await service.getCharacteristic(P.UUID.ftmsControlPoint).catch(() => null);
    if (!this.cp) {
      this.log('Sin control point: el rodillo sólo informa, no obedece.', 'warn');
      this.supports.slope = this.supports.erg = this.supports.resistance = false;
      return;
    }

    await this.cp.startNotifications().catch(() => {});
    this.cp.addEventListener('characteristicvaluechanged', (e) => {
      const r = P.parseControlResponse(e.target.value);
      if (r && !r.ok) this.log(`FTMS rechazó 0x${r.op.toString(16)}: ${r.message}.`, 'warn');
    });

    // Tomar el control y arrancar. Sin el 0x00 inicial, todo lo demás
    // devuelve "control no permitido".
    await this._write(P.ftmsRequestControl());
    await this._write(P.ftmsStart());
    this.hasControl = true;
  }

  async _setupPowerOnly() {
    const cps = await this.server.getPrimaryService(P.UUID.cyclingPower).catch(() => null);
    if (!cps) {
      throw new Error(
        'El dispositivo no expone ni FTMS (0x1826) ni Cycling Power (0x1818).'
      );
    }
    this.log('Sin FTMS. Modo sólo-medición sobre Cycling Power.', 'warn');
    Object.assign(this.supports, { power: true, cadence: true });

    const ch = await cps.getCharacteristic(P.UUID.cyclingPowerMeasurement);
    await ch.startNotifications();

    let lastRevs = null;
    let lastTime = null;
    ch.addEventListener('characteristicvaluechanged', (e) => {
      const d = P.parseCyclingPower(e.target.value);
      let cadence;
      // La cadencia no viene en claro: se deriva de los contadores de biela,
      // cuyo reloj corre a 1024 Hz y da la vuelta a los 64 s.
      if (d.crankRevs !== undefined && lastRevs !== null) {
        const dr = (d.crankRevs - lastRevs + 65536) % 65536;
        const dt = ((d.crankTime - lastTime + 65536) % 65536) / 1024;
        if (dt > 0.1 && dr < 20) cadence = (dr / dt) * 60;
      }
      if (d.crankRevs !== undefined) {
        lastRevs = d.crankRevs;
        lastTime = d.crankTime;
      }
      this.emitData({ power: d.power, cadence, source: 'cps' });
    });
  }

  async _setupHeartRate() {
    try {
      const hrs = await this.server.getPrimaryService(P.UUID.heartRate);
      const ch = await hrs.getCharacteristic(P.UUID.heartRateMeasurement);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (e) => {
        this.emitData({ hr: P.parseHeartRate(e.target.value).hr, source: 'hr' });
      });
      this.supports.hr = true;
    } catch { /* la banda suele ser un aparato aparte */ }
  }

  _write(bytes) {
    if (!this.cp) return Promise.resolve();
    return this.queue.push(async () => {
      if (!this.device?.gatt?.connected) return;
      // writeValueWithResponse es lo correcto para un control point; algunos
      // firmwares viejos sólo implementan el método genérico.
      if (this.cp.writeValueWithResponse) await this.cp.writeValueWithResponse(bytes);
      else await this.cp.writeValue(bytes);
    });
  }

  async setSlope(grade, crr = 0.004, cw = 0.51) {
    if (this.fec) return this.fec.setSlope(grade, crr);
    if (!this.supports.slope) return;
    await this._write(P.ftmsSimulation(grade, crr, cw));
  }

  async setTargetPower(watts) {
    if (this.fec) return this.fec.setTargetPower(watts);
    if (!this.supports.erg) return;
    const w = this.powerRange
      ? P.clamp(watts, this.powerRange.min, this.powerRange.max)
      : watts;
    await this._write(P.ftmsTargetPower(w));
  }

  async setResistance(percent) {
    if (this.fec) return this.fec.setResistance(percent);
    if (!this.supports.resistance) return;
    await this._write(P.ftmsTargetResistance(percent));
  }

  async setRider(rider) {
    // FTMS lleva la masa dentro de cada consigna de simulación; FE-C la
    // configura una vez con la página 55.
    if (this.fec) await this.fec.setRider(rider);
  }

  async disconnect() {
    this.fec?.stopKeepalive();
    try {
      if (this.hasControl) await this._write(P.ftmsStop());
    } catch { /* da igual: nos vamos igual */ }
    this.device?.removeEventListener('gattserverdisconnected', this._onDisconnect);
    try { this.device?.gatt?.disconnect(); } catch { /* ya estaba fuera */ }
    this.setConnected(false);
  }
}
