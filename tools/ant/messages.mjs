/**
 * Capa de mensajes ANT: el protocolo serie que habla un palo USB ANT+.
 *
 * Esto es la capa de debajo de FE-C. FE-C define QUÉ se dice (las páginas
 * que ya están en js/trainer/protocol.js); esto define CÓMO se le dice al
 * palo que abra un canal, lo sintonice y transmita.
 *
 * Toda trama tiene la misma forma:
 *
 *   A4 <len> <id> <datos...> <checksum>
 *    │    │     │              └─ XOR de todos los bytes anteriores
 *    │    │     └─ identificador de mensaje
 *    │    └─ número de bytes de datos (sin contar id ni checksum)
 *    └─ sincronismo, siempre 0xA4 desde el host
 *
 * El módulo es puro: no toca USB ni importa nada. Así se puede probar
 * entero sin tener un palo enchufado, que es justo lo que hace
 * tools/check-ant.mjs.
 */

export const SYNC = 0xa4;

/** Identificadores de mensaje que usamos. */
export const MSG = {
  // Configuración
  UNASSIGN_CHANNEL: 0x41,
  ASSIGN_CHANNEL: 0x42,
  CHANNEL_PERIOD: 0x43,
  SEARCH_TIMEOUT: 0x44,
  CHANNEL_RF_FREQ: 0x45,
  NETWORK_KEY: 0x46,
  TRANSMIT_POWER: 0x47,
  SEARCH_WAVEFORM: 0x49,
  LOW_PRIORITY_SEARCH_TIMEOUT: 0x63,
  // Control
  RESET_SYSTEM: 0x4a,
  OPEN_CHANNEL: 0x4b,
  CLOSE_CHANNEL: 0x4c,
  REQUEST_MESSAGE: 0x4d,
  OPEN_RX_SCAN_MODE: 0x5b,
  // Datos
  BROADCAST_DATA: 0x4e,
  ACKNOWLEDGED_DATA: 0x4f,
  BURST_DATA: 0x50,
  // Respuestas
  CHANNEL_EVENT: 0x40,
  CHANNEL_ID: 0x51,
  CHANNEL_STATUS: 0x52,
  CAPABILITIES: 0x54,
  VERSION: 0x3e,
  SERIAL_NUMBER: 0x61,
  STARTUP_MESSAGE: 0x6f,
};

/** Códigos de evento del mensaje 0x40, los que de verdad aparecen. */
export const EVENT = {
  0x00: 'RESPONSE_NO_ERROR',
  0x01: 'EVENT_RX_SEARCH_TIMEOUT',
  0x02: 'EVENT_RX_FAIL',
  0x03: 'EVENT_TX',
  0x04: 'EVENT_TRANSFER_RX_FAILED',
  0x05: 'EVENT_TRANSFER_TX_COMPLETED',
  0x06: 'EVENT_TRANSFER_TX_FAILED',
  0x07: 'EVENT_CHANNEL_CLOSED',
  0x08: 'EVENT_RX_FAIL_GO_TO_SEARCH',
  0x09: 'EVENT_CHANNEL_COLLISION',
  0x15: 'CHANNEL_IN_WRONG_STATE',
  0x16: 'CHANNEL_NOT_OPENED',
  0x18: 'CHANNEL_ID_NOT_SET',
  0x19: 'CLOSE_ALL_CHANNELS',
  0x1f: 'TRANSFER_IN_PROGRESS',
  0x20: 'TRANSFER_SEQUENCE_NUMBER_ERROR',
  0x21: 'TRANSFER_IN_ERROR',
  0x28: 'MESSAGE_SIZE_EXCEEDS_LIMIT',
  0x29: 'INVALID_MESSAGE',
  0x2a: 'INVALID_NETWORK_NUMBER',
  0x30: 'INVALID_LIST_ID',
  0x31: 'INVALID_SCAN_TX_CHANNEL',
  0x33: 'INVALID_PARAMETER_PROVIDED',
};

/** Tipos de canal. Para un rodillo somos esclavo bidireccional. */
export const CHANNEL_TYPE = {
  BIDIRECTIONAL_SLAVE: 0x00,
  BIDIRECTIONAL_MASTER: 0x10,
  SHARED_BIDIRECTIONAL_SLAVE: 0x20,
  SHARED_BIDIRECTIONAL_MASTER: 0x30,
  SLAVE_RECEIVE_ONLY: 0x40,
};

/**
 * Parámetros del perfil FE-C (Fitness Equipment Control), tal y como los
 * fija el propio perfil de dispositivo de ANT+. No son ajustables: si la
 * frecuencia o el periodo no son exactamente estos, el rodillo no aparece.
 */
export const FEC = {
  deviceType: 17,       // 0x11
  rfFrequency: 57,      // 2457 MHz
  channelPeriod: 8192,  // 32768/8192 = 4 mensajes por segundo
  searchTimeout: 255,   // 255 = búsqueda indefinida
  transmissionType: 0,  // comodín: aceptamos cualquiera
};

/** XOR de todos los bytes, sincronismo incluido. */
export function checksum(bytes) {
  let x = 0;
  for (const b of bytes) x ^= b;
  return x & 0xff;
}

/** Construye una trama completa a partir de un id y sus datos. */
export function message(id, data = []) {
  const body = [SYNC, data.length, id, ...data];
  return Uint8Array.from([...body, checksum(body)]);
}

/* ------------------------------------------------------------------ *
 *  Mensajes de configuración
 * ------------------------------------------------------------------ */

export const resetSystem = () => message(MSG.RESET_SYSTEM, [0x00]);

/**
 * La clave de red de ANT+ no se publica aquí a propósito: se obtiene al
 * aceptar el acuerdo de adoptante en thisisant.com. El puente la lee de la
 * configuración y aborta con un mensaje claro si falta.
 */
export function setNetworkKey(network, key) {
  if (!key || key.length !== 8) {
    throw new Error('La clave de red ANT+ son exactamente 8 bytes.');
  }
  return message(MSG.NETWORK_KEY, [network, ...key]);
}

export const assignChannel = (channel, type, network = 0) =>
  message(MSG.ASSIGN_CHANNEL, [channel, type, network]);

export const unassignChannel = (channel) => message(MSG.UNASSIGN_CHANNEL, [channel]);

/** deviceNumber 0 es comodín: engancha con el primer rodillo que aparezca. */
export const setChannelId = (channel, deviceNumber, deviceType, transmissionType) =>
  message(MSG.CHANNEL_ID, [
    channel,
    deviceNumber & 0xff,
    (deviceNumber >> 8) & 0xff,
    deviceType,
    transmissionType,
  ]);

export const setChannelPeriod = (channel, period) =>
  message(MSG.CHANNEL_PERIOD, [channel, period & 0xff, (period >> 8) & 0xff]);

export const setChannelRfFrequency = (channel, freq) =>
  message(MSG.CHANNEL_RF_FREQ, [channel, freq]);

export const setSearchTimeout = (channel, timeout) =>
  message(MSG.SEARCH_TIMEOUT, [channel, timeout]);

export const setLowPrioritySearchTimeout = (channel, timeout) =>
  message(MSG.LOW_PRIORITY_SEARCH_TIMEOUT, [channel, timeout]);

export const setTransmitPower = (power) => message(MSG.TRANSMIT_POWER, [0x00, power]);

export const openChannel = (channel) => message(MSG.OPEN_CHANNEL, [channel]);
export const closeChannel = (channel) => message(MSG.CLOSE_CHANNEL, [channel]);

export const requestMessage = (channel, id) => message(MSG.REQUEST_MESSAGE, [channel, id]);

/** Envía una página FE-C como dato reconocido (el rodillo confirma recepción). */
export const acknowledgedData = (channel, page8) => {
  if (page8.length !== 8) throw new Error('Una página FE-C ocupa 8 bytes.');
  return message(MSG.ACKNOWLEDGED_DATA, [channel, ...page8]);
};

export const broadcastData = (channel, page8) =>
  message(MSG.BROADCAST_DATA, [channel, ...page8]);

/**
 * La secuencia completa para engancharse a un rodillo FE-C, en orden.
 * El orden importa: el palo rechaza configurar un canal que no ha sido
 * asignado, y rechaza abrir uno al que le falte el identificador.
 */
export function openFecChannel({ channel = 0, network = 0, networkKey, deviceNumber = 0 }) {
  return [
    { name: 'clave de red', bytes: setNetworkKey(network, networkKey) },
    { name: 'asignar canal', bytes: assignChannel(channel, CHANNEL_TYPE.BIDIRECTIONAL_SLAVE, network) },
    { name: 'identificador de canal', bytes: setChannelId(channel, deviceNumber, FEC.deviceType, FEC.transmissionType) },
    { name: 'frecuencia RF', bytes: setChannelRfFrequency(channel, FEC.rfFrequency) },
    { name: 'periodo de canal', bytes: setChannelPeriod(channel, FEC.channelPeriod) },
    { name: 'tiempo de búsqueda', bytes: setSearchTimeout(channel, FEC.searchTimeout) },
    { name: 'abrir canal', bytes: openChannel(channel) },
  ];
}

/* ------------------------------------------------------------------ *
 *  Lectura del flujo entrante
 * ------------------------------------------------------------------ */

/**
 * Decodificador incremental. El endpoint bulk del palo entrega trozos
 * arbitrarios: media trama, dos y pico, o basura si se perdió el
 * sincronismo. Esta clase acumula y devuelve sólo tramas completas y con
 * checksum correcto.
 */
export class MessageReader {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.discarded = 0;
  }

  /** @returns {Array<{id:number, data:Uint8Array}>} */
  push(chunk) {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const merged = new Uint8Array(this.buffer.length + incoming.length);
    merged.set(this.buffer);
    merged.set(incoming, this.buffer.length);

    const out = [];
    let offset = 0;

    while (offset < merged.length) {
      // Resincronizar: saltar lo que no empiece por el byte de sincronismo.
      if (merged[offset] !== SYNC) {
        offset++;
        this.discarded++;
        continue;
      }
      if (offset + 3 > merged.length) break;      // falta cabecera
      const len = merged[offset + 1];
      const end = offset + 4 + len;                // sync + len + id + datos + checksum
      if (end > merged.length) break;              // trama incompleta

      const frame = merged.subarray(offset, end);
      if (checksum(frame.subarray(0, frame.length - 1)) === frame[frame.length - 1]) {
        out.push({ id: merged[offset + 2], data: merged.slice(offset + 3, end - 1) });
        offset = end;
      } else {
        // Checksum malo: puede ser un 0xA4 que en realidad era un byte de
        // datos. Avanzamos uno y volvemos a buscar sincronismo.
        offset++;
        this.discarded++;
      }
    }

    this.buffer = merged.slice(offset);
    return out;
  }
}

/** Interpreta un mensaje ya decodificado en algo con sentido. */
export function describe({ id, data }) {
  switch (id) {
    case MSG.CHANNEL_EVENT: {
      // Dos formas con el mismo id: respuesta a un comando (el segundo byte
      // es el id del mensaje respondido) o evento espontáneo (segundo byte 1).
      const [channel, messageId, code] = data;
      return {
        kind: messageId === 0x01 ? 'event' : 'response',
        channel,
        respondsTo: messageId,
        code,
        name: EVENT[code] ?? `0x${code.toString(16)}`,
        ok: code === 0x00,
      };
    }
    case MSG.BROADCAST_DATA:
      return { kind: 'broadcast', channel: data[0], page: data.slice(1, 9) };
    case MSG.ACKNOWLEDGED_DATA:
      return { kind: 'acknowledged', channel: data[0], page: data.slice(1, 9) };
    case MSG.CHANNEL_ID:
      return {
        kind: 'channelId',
        channel: data[0],
        deviceNumber: data[1] | (data[2] << 8),
        deviceType: data[3],
        transmissionType: data[4],
      };
    case MSG.STARTUP_MESSAGE:
      return { kind: 'startup', reason: data[0] };
    case MSG.CAPABILITIES:
      return { kind: 'capabilities', maxChannels: data[0], maxNetworks: data[1] };
    case MSG.SERIAL_NUMBER:
      return { kind: 'serial', serial: data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24) };
    default:
      return { kind: 'other', id, data };
  }
}

/** Convierte "A1-B2-…" o "a1b2…" en los 8 bytes de la clave. */
export function parseNetworkKey(text) {
  if (!text) return null;
  const hex = String(text).replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 16) {
    throw new Error(
      `La clave de red ANT+ debe tener 16 dígitos hexadecimales (8 bytes); recibí ${hex.length}.`
    );
  }
  return Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
}
