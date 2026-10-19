import { TrainerAdapter } from './base.js';
import * as Phys from '../physics.js';

/**
 * Rodillo simulado.
 *
 * No es un juguete de relleno: es lo que permite probar una ruta entera,
 * verificar el perfil y usar la app en un iPad sin Web Bluetooth. Modela a
 * un ciclista que sostiene una potencia objetivo con la variabilidad y la
 * inercia de alguien real, y que acusa la pendiente como la acusa una
 * persona (sube algo los vatios en la rampa, los suelta en la bajada).
 */
export class SimAdapter extends TrainerAdapter {
  static id = 'sim';
  static label = 'Simulador';
  static blurb = 'Sin hardware. Para probar rutas y para rodar cuando el rodillo no está.';

  static async available() {
    return true;
  }

  constructor({ ftp = 220, hz = 4 } = {}) {
    super();
    this.ftp = ftp;
    this.hz = hz;
    this.timer = null;
    this.grade = 0;
    this.targetPower = null;   // si está puesto, manda el modo ERG
    this.effort = 0.72;        // fracción del FTP que el ciclista quiere sostener
    this.power = 0;
    this.cadence = 0;
    this.hr = 95;
    this.t = 0;
    Object.assign(this.supports, {
      power: true, cadence: true, speed: true, hr: true,
      slope: true, erg: true, resistance: true,
    });
  }

  async connect() {
    this.t = 0;
    this.timer = setInterval(() => this._tick(), 1000 / this.hz);
    this.log('Simulador en marcha. Ajustá el esfuerzo desde la barra inferior.');
    this.setConnected(true, 'Simulador');
    return this;
  }

  /** Esfuerzo deseado como fracción del FTP (0.4 a 1.5). */
  setEffort(fraction) {
    this.effort = Math.max(0.3, Math.min(1.6, fraction));
  }

  _tick() {
    const dt = 1 / this.hz;
    this.t += dt;

    // Objetivo: en ERG lo fija el entrenamiento; si no, el propio ciclista,
    // que empuja un poco más cuando la carretera se empina.
    const gradeBias = 1 + Math.max(-0.12, Math.min(0.18, this.grade * 1.6));
    const target = this.targetPower ?? this.ftp * this.effort * gradeBias;

    // Variabilidad: respiración lenta + micro-oscilación del pedaleo.
    const wobble =
      1 +
      0.045 * Math.sin(this.t / 9) +
      0.03 * Math.sin(this.t / 2.3) +
      0.02 * (Math.random() - 0.5);

    // Primer orden hacia el objetivo: nadie cambia de 150 a 300 W de golpe.
    const want = Math.max(0, target * wobble);
    this.power += (want - this.power) * Math.min(1, dt * 1.8);

    // Cadencia: más alta en llano, se desploma en la rampa larga.
    const baseRpm = 92 - Math.max(0, this.grade) * 170;
    this.cadence += (baseRpm + 3 * Math.sin(this.t / 4) - this.cadence) * Math.min(1, dt * 1.2);
    this.cadence = Math.max(0, this.cadence);

    // Deriva cardíaca: la frecuencia persigue la potencia con retardo
    // y sube despacio a lo largo de la sesión.
    const hrTarget = 95 + (this.power / this.ftp) * 72 + Math.min(12, this.t / 300);
    this.hr += (hrTarget - this.hr) * Math.min(1, dt * 0.08);

    this.emitData({
      power: Math.round(this.power),
      cadence: Math.round(this.cadence),
      hr: Math.round(this.hr),
      trainerSpeed: Phys.steadySpeed(this.power, this.grade, Phys.DEFAULT_RIDER),
      source: 'sim',
    });
  }

  async setSlope(grade) { this.grade = grade; }
  async setTargetPower(watts) { this.targetPower = watts > 0 ? watts : null; }
  async setResistance(percent) { this.grade = (percent / 100) * 0.15; }

  async disconnect() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setConnected(false);
  }
}
