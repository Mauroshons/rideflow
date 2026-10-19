import { TrainerAdapter, WriteQueue } from './base.js';
import * as P from './protocol.js';

/**
 * Tacx FE-C sobre BLE.
 *
 * Los Tacx de la generación Flow / Vortex / Bushido Smart exponen el servicio
 * 6e40fec1-… y transportan por él mensajes ANT+ FE-C enteros, trama incluida.
 * Es decir: por dentro siguen hablando ANT+, sólo que el transporte es
 * Bluetooth. Por eso aquí se construyen páginas FE-C y no opcodes FTMS.
 *
 * Nota de campo: en un Flow la potencia es estimada a partir de la curva del
 * rodillo y la velocidad de la rueda, no medida en el eje. Depende de la
 * presión del rodillo contra la cubierta; sin calibrar no esperes que
 * coincida con un medidor de potencia real. Para entrenar por zonas es
 * suficiente siempre que la referencia sea el propio rodillo.
 */

/**
 * El canal FE-C, aislado del adaptador que lo use.
 *
 * Vive aparte porque hay dos caminos que acaban aquí: elegir "Tacx FE-C" a
 * mano, y conectar por FTMS a un rodillo que resulta no tener FTMS. Antes
 * esa segunda vía dejaba al usuario con un medidor sin control y un aviso
 * pidiéndole que volviera atrás y eligiera otro adaptador.
 */
export class FecChannel {
  constructor({ onData, onLog }) {
    this.onData = onData;
    this.onLog = onLog ?? (() => {});
    this.txChar = null;
    this.queue = new WriteQueue();
    this.lastCommand = null;
    this.keepaliveTimer = null;
    this.supportsWriteWithoutResponse = true;
    this._warnedCalibration = false;
    this._isConnected = () => false;
  }

  /** @param {BluetoothRemoteGATTService} service el servicio 6e40fec1-… */
  async attach(service, isConnected) {
    this._isConnected = isConnected;
    this.txChar = await service.getCharacteristic(P.UUID.tacxFecWrite);
    const rx = await service.getCharacteristic(P.UUID.tacxFecNotify);
    await rx.startNotifications();
    rx.addEventListener('characteristicvaluechanged', (e) => this._onFrame(e.target.value));
    return this;
  }

  _onFrame(dataView) {
    const page = P.antUnframe(new Uint8Array(dataView.buffer));
    if (!page) return;
    const d = P.parseFecPage(page);
    if (!d) return;

    if (d.page === 25) {
      this.onData({
        power: d.power ?? undefined,
        cadence: d.cadence ?? undefined,
        source: 'fec25',
      });
      if (d.calibrationNeeded && !this._warnedCalibration) {
        this._warnedCalibration = true;
        this.onLog('El rodillo pide calibración (rodá 10 min y hacé un spin-down).', 'warn');
      }
    } else if (d.page === 16) {
      this.onData({
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
      if (this.lastCommand && this._isConnected()) this.send(this.lastCommand, false);
    }, periodMs);
  }

  stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  send(page8, remember = true) {
    if (remember) this.lastCommand = page8;
    return this.queue.push(async () => {
      if (!this._isConnected() || !this.txChar) return;
      const frame = P.antFrame(page8);

      // El canal de Tacx es sin respuesta, y pedirla hace que algunos
      // firmwares corten la conexión a los pocos segundos. Pero que el
      // método exista no significa que la característica lo admita: Chrome
      // lo expone siempre y lanza NotSupportedError al llamarlo. Así que se
      // intenta, y si el aparato dice que no, se cambia de método para
      // siempre en lugar de fallar una escritura por segundo.
      if (this.supportsWriteWithoutResponse && this.txChar.writeValueWithoutResponse) {
        try {
          await this.txChar.writeValueWithoutResponse(frame);
          return;
        } catch (err) {
          if (err.name !== 'NotSupportedError') throw err;
          this.supportsWriteWithoutResponse = false;
          this.onLog('La característica no admite escritura sin respuesta; cambio de método.', 'warn');
        }
      }
      await this.txChar.writeValue(frame);
    });
  }

  setSlope(grade, crr = 0.004) { return this.send(P.fecTrackResistance(grade, crr)); }
  setTargetPower(watts) { return this.send(P.fecTargetPower(watts)); }
  setResistance(percent) { return this.send(P.fecBasicResistance(percent)); }

  /** La configuración de usuario no es una consigna: no entra al keepalive. */
  setRider({ riderKg, bikeKg }) {
    return this.send(P.fecUserConfig(riderKg ?? 75, bikeKg ?? 8.5), false);
  }
}

export class TacxFecAdapter extends TrainerAdapter {
  static id = 'tacx-fec';
  static label = 'Tacx FE-C (Flow / Vortex / Bushido)';
  static blurb = 'Protocolo ANT+ FE-C encapsulado en BLE, el que usan los Tacx Smart.';

  static async available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  constructor({ showAllDevices = false } = {}) {
    super();
    this.device = null;
    this.showAllDevices = showAllDevices;
    this.rider = { riderKg: 75, bikeKg: 8.5 };
    this.fec = new FecChannel({
      onData: (d) => this.emitData(d),
      onLog: (m, l) => this.log(m, l),
    });
    this._onDisconnect = () => {
      this.fec.stopKeepalive();
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

    this.device = await navigator.bluetooth.requestDevice(
      requestOptions(this.showAllDevices, [P.UUID.tacxFec])
    );

    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);
    const server = await this.device.gatt.connect();

    const service = await server.getPrimaryService(P.UUID.tacxFec).catch(() => null);
    if (!service) {
      try { this.device.gatt.disconnect(); } catch { /* da igual */ }
      throw new Error(
        `${this.device.name ?? 'El dispositivo'} no expone el servicio FE-C de Tacx. ` +
        'Si es un rodillo moderno, probá con el adaptador FTMS.'
      );
    }

    await this.fec.attach(service, () => !!this.device?.gatt?.connected);

    Object.assign(this.supports, {
      power: true, cadence: true, speed: true, slope: true, erg: true, resistance: true,
    });

    // El rodillo necesita conocer la masa para calcular la inercia del
    // volante virtual; sin esto las bajadas y los arranques se sienten mal.
    await this.setRider(this.rider);
    await this.setSlope(0);
    this.fec.startKeepalive();

    this.log(`Conectado a ${this.device.name ?? 'Tacx'} por FE-C.`);
    this.setConnected(true, this.device.name ?? 'Tacx');
    return this;
  }

  async setSlope(grade, crr = 0.004) { await this.fec.setSlope(grade, crr); }
  async setTargetPower(watts) { await this.fec.setTargetPower(watts); }
  async setResistance(percent) { await this.fec.setResistance(percent); }

  async setRider(rider) {
    this.rider = { ...this.rider, ...rider };
    await this.fec.setRider(this.rider);
  }

  async disconnect() {
    this.fec.stopKeepalive();
    try { await this.setSlope(0); } catch { /* nos vamos igual */ }
    this.device?.removeEventListener('gattserverdisconnected', this._onDisconnect);
    try { this.device?.gatt?.disconnect(); } catch { /* ya estaba fuera */ }
    this.setConnected(false);
  }
}

/**
 * Opciones para requestDevice.
 *
 * Esto parece un detalle y es la causa número uno de "mi rodillo no aparece".
 * El selector de Chrome sólo muestra lo que encaja con los filtros, y los
 * filtros se aplican al PAQUETE DE PUBLICIDAD, no a los servicios que el
 * aparato tiene. Muchos rodillos —el Flow entre ellos— anuncian el nombre y
 * poco más, y dejan los servicios para cuando ya te conectaste. Un filtro
 * por servicio los deja fuera de la lista aunque los soporten.
 *
 * Por eso van también los filtros por nombre, y por eso existe la opción de
 * mostrarlo todo: con acceptAllDevices el selector enseña cualquier cosa que
 * emita, que es feo pero encuentra al rodillo.
 */
export function requestOptions(showAllDevices, preferredServices = []) {
  const optionalServices = [
    P.UUID.ftms,
    P.UUID.cyclingPower,
    P.UUID.heartRate,
    P.UUID.deviceInfo,
    P.UUID.tacxFec,
  ];

  if (showAllDevices) return { acceptAllDevices: true, optionalServices };

  return {
    filters: [
      ...preferredServices.map((s) => ({ services: [s] })),
      { services: [P.UUID.ftms] },
      { services: [P.UUID.cyclingPower] },
      { services: [P.UUID.tacxFec] },
      // Los nombres con los que se anuncian de fábrica.
      { namePrefix: 'Tacx' },
      { namePrefix: 'TACX' },
      { namePrefix: 'Flow' },
      { namePrefix: 'Vortex' },
      { namePrefix: 'Bushido' },
      { namePrefix: 'Satori' },
      { namePrefix: 'Genius' },
      { namePrefix: 'Magnum' },
      { namePrefix: 'NEO' },
    ],
    optionalServices,
  };
}
