import * as Phys from './physics.js';
import { sampleAt, profileStats } from './geo.js';

/**
 * Motor de una sesión: avanza por la ruta, manda la pendiente al rodillo y
 * graba lo ocurrido.
 *
 * El avance NO sale de la velocidad que informa el rodillo (esa es la del
 * volante y depende del desarrollo que lleves puesto), sino de integrar la
 * potencia medida contra la pendiente del tramo. Es la única forma de que
 * subir el Alpe cueste lo que cuesta subir el Alpe.
 */
export class RideEngine extends EventTarget {
  constructor(trainer, { hz = 10 } = {}) {
    super();
    this.trainer = trainer;
    this.hz = hz;
    this.route = null;
    this.samples = null;
    this.stats = null;

    this.state = 'idle';     // idle | running | paused | finished
    this.distance = 0;       // metros recorridos sobre la ruta
    this.speed = 0;          // m/s virtuales
    this.elapsed = 0;        // segundos en movimiento
    this.kJ = 0;
    this.position = null;

    this._timer = null;
    this._lastTick = 0;
    this._powerLog = [];
    this._recorded = [];
    this._maxPower = 0;
    this._maxSpeed = 0;
    this._powerSum = 0;
    this._powerN = 0;
    this._lastRecordAt = -1;
    this.startedAt = null;
    this.laps = [];
  }

  /** Carga una ruta ya perfilada (array de muestras de geo.buildProfile). */
  load(route, samples) {
    this.reset();
    this.route = route;
    this.samples = samples;
    this.stats = profileStats(samples);
    this.position = sampleAt(samples, 0);
    this.dispatchEvent(new CustomEvent('loaded', { detail: { route, stats: this.stats } }));
  }

  reset() {
    this.stop();
    this.state = 'idle';
    this.distance = 0;
    this.speed = 0;
    this.elapsed = 0;
    this.kJ = 0;
    this._powerLog = [];
    this._recorded = [];
    this._maxPower = 0;
    this._maxSpeed = 0;
    this._powerSum = 0;
    this._powerN = 0;
    this._lastRecordAt = -1;
    this.laps = [];
    this.startedAt = null;
    if (this.samples) this.position = sampleAt(this.samples, 0);
    this.dispatchEvent(new CustomEvent('reset'));
  }

  start() {
    if (!this.samples) throw new Error('No hay ninguna ruta cargada.');
    if (this.state === 'running') return;
    if (this.state === 'idle') this.startedAt = Date.now();
    this.state = 'running';
    this._lastTick = performance.now();
    this._timer = setInterval(() => this._tick(), 1000 / this.hz);
    this.dispatchEvent(new CustomEvent('state', { detail: this.state }));
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.stop();
    // Soltar la resistencia al pausar: nadie quiere volver a una bici
    // clavada al 12% después de ir a buscar agua.
    this.trainer.requestSlope(0);
    this.dispatchEvent(new CustomEvent('state', { detail: this.state }));
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Salta a una distancia concreta de la ruta (arrastrar el perfil). */
  seek(meters) {
    if (!this.samples) return;
    // Volver atrás después de llegar a meta deja la ruta otra vez por
    // delante: la sesión pasa a pausada en lugar de quedarse muerta.
    if (this.state === 'finished' && meters < this.stats.distance - 1) {
      this.state = 'paused';
      this.dispatchEvent(new CustomEvent('state', { detail: this.state }));
    }
    this.distance = Math.max(0, Math.min(this.stats.distance, meters));
    this.position = sampleAt(this.samples, this.distance);
    this.trainer.requestSlope(this.position.grade);
    this.dispatchEvent(new CustomEvent('tick', { detail: this.snapshot() }));
  }

  lap() {
    this.laps.push({
      at: this.elapsed,
      distance: this.distance,
      avgPower: this._powerN ? this._powerSum / this._powerN : 0,
    });
    this.dispatchEvent(new CustomEvent('lap', { detail: this.laps[this.laps.length - 1] }));
  }

  _tick() {
    const now = performance.now();
    let dt = (now - this._lastTick) / 1000;
    this._lastTick = now;
    // Si el iPad bloqueó la pantalla o cambiaste de app, el intervalo vuelve
    // con un salto enorme. Integrar ese salto de golpe teletransporta al
    // ciclista; mejor acotarlo y perder ese tiempo.
    if (dt > 1) dt = 1 / this.hz;

    const power = this.trainer.metrics.stale ? 0 : this.trainer.metrics.power ?? 0;
    const cfg = this.trainer.rider;
    const grade = this.position?.grade ?? 0;

    this.speed = Phys.step(this.speed, power, grade, cfg, dt);
    this.distance += this.speed * dt;
    this.elapsed += dt;
    this.kJ += (power * dt) / 1000;

    if (power > 0) {
      this._powerSum += power;
      this._powerN++;
      this._powerLog.push(power);
      if (this._powerLog.length > 60 * 60 * this.hz) this._powerLog.shift();
    }
    if (power > this._maxPower) this._maxPower = power;
    if (this.speed > this._maxSpeed) this._maxSpeed = this.speed;

    this.position = sampleAt(this.samples, this.distance);
    this.trainer.requestSlope(this.position.grade);

    // Grabación a 1 Hz: suficiente para Strava y no infla el archivo.
    const sec = Math.floor(this.elapsed);
    if (sec !== this._lastRecordAt) {
      this._lastRecordAt = sec;
      this._recorded.push({
        t: sec,
        lat: this.position.lat,
        lon: this.position.lon,
        ele: this.position.ele,
        dist: this.distance,
        speed: this.speed,
        power,
        cadence: this.trainer.metrics.cadence ?? 0,
        hr: this.trainer.metrics.hr ?? 0,
        grade: this.position.grade,
      });
    }

    if (this.position.done) {
      this.state = 'finished';
      this.stop();
      this.trainer.requestSlope(0);
      this.dispatchEvent(new CustomEvent('finished', { detail: this.session() }));
      this.dispatchEvent(new CustomEvent('state', { detail: this.state }));
      return;
    }

    this.dispatchEvent(new CustomEvent('tick', { detail: this.snapshot() }));
  }

  snapshot() {
    const avgPower = this._powerN ? this._powerSum / this._powerN : 0;
    const remaining = (this.stats?.distance ?? 0) - this.distance;
    return {
      state: this.state,
      distance: this.distance,
      remaining,
      progress: this.stats?.distance ? this.distance / this.stats.distance : 0,
      elapsed: this.elapsed,
      // Tiempo estimado al final con el ritmo actual, no con la media:
      // en un puerto la media de toda la subida miente.
      eta: this.speed > 0.5 ? remaining / this.speed : null,
      speed: this.speed,
      power: this.trainer.metrics.power ?? 0,
      cadence: this.trainer.metrics.cadence ?? 0,
      hr: this.trainer.metrics.hr ?? 0,
      avgPower,
      maxPower: this._maxPower,
      kJ: this.kJ,
      grade: this.position?.grade ?? 0,
      ele: this.position?.ele ?? 0,
      lat: this.position?.lat,
      lon: this.position?.lon,
      np: Phys.normalizedPower(this._powerLog, this.hz),
    };
  }

  /** Objeto listo para exportar a TCX o guardar en el historial. */
  session() {
    const avgPower = this._powerN ? this._powerSum / this._powerN : 0;
    const np = Phys.normalizedPower(this._powerLog, this.hz);
    const ftp = this.trainer.rider.ftp ?? 0;
    return {
      routeId: this.route?.id ?? null,
      routeName: this.route?.name ?? 'Ruta',
      startedAt: this.startedAt ?? Date.now(),
      elapsed: this.elapsed,
      distance: this.distance,
      gain: Math.round(
        this.samples
          ? this.samples
              .filter((s) => s.dTotal <= this.distance)
              .reduce((acc, s, i, arr) => (i > 0 ? acc + Math.max(0, s.ele - arr[i - 1].ele) : 0), 0)
          : 0
      ),
      avgPower,
      maxPower: this._maxPower,
      maxSpeed: this._maxSpeed,
      np,
      // Intensity Factor y TSS: las dos cifras con las que de verdad se
      // compara una sesión contra otra.
      intensityFactor: ftp ? np / ftp : null,
      tss: ftp ? ((this.elapsed * np * (np / ftp)) / (ftp * 3600)) * 100 : null,
      kJ: this.kJ,
      laps: this.laps,
      samples: this._recorded,
    };
  }
}
