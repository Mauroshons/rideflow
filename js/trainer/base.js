/**
 * Contrato común a todos los adaptadores de rodillo.
 *
 * La app nunca habla Bluetooth directamente: pide "ponme un 7% de
 * pendiente" y el adaptador decide si eso es una página 51 de FE-C, un
 * opcode 0x11 de FTMS o un número en una simulación.
 */
export class TrainerAdapter extends EventTarget {
  /** @type {string} identificador estable */
  static id = 'base';
  /** @type {string} nombre visible */
  static label = 'Adaptador';
  /** @type {string} una línea para la pantalla de conexión */
  static blurb = '';

  /** ¿Puede este adaptador funcionar en el runtime actual? */
  static async available() {
    return false;
  }

  constructor() {
    super();
    this.connected = false;
    this.deviceName = null;
    /** Qué sabe hacer: se ajusta tras negociar con el aparato. */
    this.supports = {
      power: false,
      cadence: false,
      speed: false,
      hr: false,
      slope: false,
      erg: false,
      resistance: false,
    };
  }

  /* --- ciclo de vida: a implementar --- */
  async connect() { throw new Error('no implementado'); }
  async disconnect() {}

  /* --- control: los que no soporte el aparato quedan en no-op --- */
  async setSlope(/* grade, crr, cw */) {}
  async setTargetPower(/* watts */) {}
  async setResistance(/* percent */) {}
  async setRider(/* { riderKg, bikeKg } */) {}

  /* --- utilidades para las subclases --- */

  /** Publica una muestra de telemetría. */
  emitData(data) {
    this.dispatchEvent(new CustomEvent('data', { detail: data }));
  }

  /** Mensaje para el registro de la app (visible en Ajustes → Diagnóstico). */
  log(message, level = 'info') {
    this.dispatchEvent(
      new CustomEvent('log', { detail: { message, level, at: Date.now() } })
    );
  }

  setConnected(value, deviceName = this.deviceName) {
    this.connected = value;
    this.deviceName = deviceName;
    this.dispatchEvent(
      new CustomEvent('status', {
        detail: { connected: value, deviceName, supports: this.supports },
      })
    );
  }
}

/**
 * Serializa las escrituras GATT. Web Bluetooth rechaza una operación si ya
 * hay otra en vuelo sobre el mismo servidor ("GATT operation already in
 * progress"), así que todo pasa por esta cola.
 */
export class WriteQueue {
  constructor() {
    this.chain = Promise.resolve();
  }

  push(fn) {
    const next = this.chain.then(fn, fn);
    // Un fallo en una escritura no debe envenenar la cadena entera.
    this.chain = next.catch(() => {});
    return next;
  }
}
