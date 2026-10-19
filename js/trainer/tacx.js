import { TrainerAdapter, WriteQueue } from './base.js';
import * as P from './protocol.js';

/**
 * Adaptador Tacx FE-C sobre BLE.
 *
 * Los Tacx de la generación Flow/Vortex/Bushido Smart exponen el servicio
 * 6e40fec1-… y transportan por él mensajes ANT+ FE-C enteros, trama
 * incluida. Es decir: por dentro siguen hablando ANT+, sólo que el
 * transporte es Bluetooth. Por eso aquí se construyen páginas FE-C y no
 * opcodes FTMS.
 *
 * Nota de campo: en un Flow la potencia es estimada a partir de la curva
 * del rodillo y la velocidad de la rueda, no medida en el eje. Depende de
 * la presión del rodillo contra la cubierta; sin calibrar no esperes que
 * coincida con un medidor de potencia real. Para entrenar por zonas es
 * suficiente siempre que la referencia sea el propio rodillo.
 */
export class TacxFecAdapter extends TrainerAdapter {
  static id = 'tacx-fec';
  static label = 'Tacx FE-C (Flow / Vortex / Bushido)';
  static blurb = 'Protocolo ANT+ FE-C encapsulado en BLE, el que usan los Tacx Smart.';

  static async available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  constructor() {
    super();
    this.device = null;
    this.txChar = null;
    this.queue = new WriteQueue();
    this.lastCommand = null;
    this.keepaliveTimer = null;
    this.rider = { riderKg: 75, bikeKg: 8.5 };
    this._onDisconnect = () => {
      this.stopKeepalive();
      this.log('El Tacx se desconectó.', 'warn');
      this.setConnected(false);
    };
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error(
        'Este navegador no expone Web Bluetooth. En iPad usá el modo Puente o el Simulador.'
      );
    }

    this.device = await navigator.bluetooth.requestDevice({
      // Tacx anuncia con nombres como "Tacx Flow 01234" o "Tacx Neo 02468".
      filters: [{ services: [P.UUID.tacxFec] }, { namePrefix: 'Tacx' }],
      optionalServices: [P.UUID.tacxFec, P.UUID.ftms, P.UUID.cyclingPower, P.UUID.heartRate],
    });

    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(P.UUID.tacxFec);

    this.txChar = await service.getCharacteristic(P.UUID.tacxFecWrite);
    const rx = await service.getCharacteristic(P.UUID.tacxFecNotify);
    await rx.startNotifications();
    rx.addEventListener('characteristicvaluechanged', (e) => this._onFrame(e.target.value));

    Object.assign(this.supports, {
      power: true, cadence: true, speed: true, slope: true, erg: true, resistance: true,
    });

    // El rodillo necesita conocer la masa para calcular la inercia del
    // volante virtual; sin esto las bajadas y los arranques se sienten mal.
    await this.setRider(this.rider);
    await this.setSlope(0);
    this.startKeepalive();

    this.log(`Conectado a ${this.device.name ?? 'Tacx'} por FE-C.`);
    this.setConnected(true, this.device.name ?? 'Tacx');
    return this;
  }

  _onFrame(dataView) {
    const page = P.antUnframe(new Uint8Array(dataView.buffer));
    if (!page) return;
    const d = P.parseFecPage(page);
    if (!d) return;

    if (d.page === 25) {
      this.emitData({
        power: d.power ?? undefined,
        cadence: d.cadence ?? undefined,
        source: 'fec25',
      });
      if (d.calibrationNeeded && !this._warnedCalibration) {
        this._warnedCalibration = true;
        this.log('El rodillo pide calibración (rodá 10 min y hacé un spin-down).', 'warn');
      }
    } else if (d.page === 16) {
      this.emitData({
        trainerSpeed: d.speed ?? undefined,
        hr: d.hr ?? undefined,
        source: 'fec16',
      });
    }
  }

  /**
   * FE-C es un protocolo de difusión: el rodillo espera recibir la consigna
   * una y otra vez. Si dejás de mandarla, algunos firmwares vuelven solos a
   * resistencia cero a mitad de una subida.
   */
  startKeepalive(periodMs = 1000) {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.lastCommand && this.device?.gatt?.connected) this._send(this.lastCommand, false);
    }, periodMs);
  }

  stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  _send(page8, remember = true) {
    if (remember) this.lastCommand = page8;
    return this.queue.push(async () => {
      if (!this.device?.gatt?.connected || !this.txChar) return;
      const frame = P.antFrame(page8);
      // El canal de Tacx es sin respuesta; pedirla hace que algunos
      // firmwares corten la conexión a los pocos segundos.
      if (this.txChar.writeValueWithoutResponse) {
        await this.txChar.writeValueWithoutResponse(frame);
      } else {
        await this.txChar.writeValue(frame);
      }
    });
  }

  async setSlope(grade, crr = 0.004) {
    await this._send(P.fecTrackResistance(grade, crr));
  }

  async setTargetPower(watts) {
    await this._send(P.fecTargetPower(watts));
  }

  async setResistance(percent) {
    await this._send(P.fecBasicResistance(percent));
  }

  async setRider({ riderKg, bikeKg }) {
    this.rider = { riderKg, bikeKg };
    // La configuración de usuario no es una consigna: no entra al keepalive.
    await this._send(P.fecUserConfig(riderKg, bikeKg), false);
  }

  async disconnect() {
    this.stopKeepalive();
    try { await this.setSlope(0); } catch { /* nos vamos igual */ }
    this.device?.removeEventListener('gattserverdisconnected', this._onDisconnect);
    try { this.device?.gatt?.disconnect(); } catch { /* ya estaba fuera */ }
    this.setConnected(false);
  }
}
