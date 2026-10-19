/**
 * Perfil de elevación en canvas.
 *
 * Se dibuja a mano en lugar de usar una librería de gráficos porque hay que
 * repintarlo diez veces por segundo con el cursor de posición encima, y
 * porque el color de cada columna codifica la pendiente: en una subida larga
 * esa banda de color dice de un vistazo lo que viene, que es exactamente lo
 * que querés saber cuando ya no te queda cabeza para leer números.
 */

const GRADE_COLORS = [
  { upTo: -0.04, color: '#3d7fb8' },
  { upTo: -0.01, color: '#4f9bd1' },
  { upTo: 0.015, color: '#4c8c5a' },
  { upTo: 0.04, color: '#88a844' },
  { upTo: 0.07, color: '#d4a53c' },
  { upTo: 0.10, color: '#d97836' },
  { upTo: 0.14, color: '#c94c3c' },
  { upTo: Infinity, color: '#8f2f44' },
];

export function gradeColor(grade) {
  return (GRADE_COLORS.find((g) => grade <= g.upTo) ?? GRADE_COLORS[GRADE_COLORS.length - 1]).color;
}

export class ProfileChart {
  constructor(canvas, { onSeek = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.samples = null;
    this.stats = null;
    this.progress = 0;        // metros recorridos
    this.hover = null;        // metros bajo el dedo
    this.onSeek = onSeek;
    this._cols = null;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this._ro = ro;

    if (onSeek) this._attachPointer();
  }

  _attachPointer() {
    let dragging = false;
    const toMeters = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
      return (x / r.width) * (this.stats?.distance ?? 0);
    };
    this.canvas.addEventListener('pointerdown', (ev) => {
      if (!this.samples) return;
      dragging = true;
      this.canvas.setPointerCapture(ev.pointerId);
      this.hover = toMeters(ev);
      this.draw();
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this.samples) return;
      this.hover = toMeters(ev);
      this.draw();
    });
    const end = (ev) => {
      if (!dragging) return;
      dragging = false;
      const m = toMeters(ev);
      this.hover = null;
      this.onSeek?.(m);
      this.draw();
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', () => { dragging = false; this.hover = null; this.draw(); });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
  }

  load(samples, stats) {
    this.samples = samples;
    this.stats = stats;
    this.progress = 0;
    this._cols = null;
    this.resize();
  }

  setProgress(meters) {
    this.progress = meters;
    this.draw();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    this._cols = null;
    this.draw();
  }

  /**
   * Remuestrea el perfil a una columna por píxel. Con 20 000 puntos y 10 fps
   * no se puede recorrer la traza entera en cada cuadro, así que el
   * remuestreo se cachea y sólo se rehace al cambiar de tamaño.
   */
  _buildColumns() {
    const n = Math.max(1, Math.floor(this.w));
    const total = this.stats.distance;
    const cols = new Array(n);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const dStart = (i / n) * total;
      const dEnd = ((i + 1) / n) * total;
      let eleSum = 0;
      let gradeSum = 0;
      let count = 0;
      while (idx < this.samples.length && this.samples[idx].dTotal < dEnd) {
        eleSum += this.samples[idx].ele;
        gradeSum += this.samples[idx].grade;
        count++;
        idx++;
      }
      if (count === 0) {
        // Columna más estrecha que el paso de la traza: tomamos el punto
        // más cercano en lugar de dejar un hueco.
        const k = Math.min(this.samples.length - 1, Math.max(0, idx - 1));
        cols[i] = { ele: this.samples[k].ele, grade: this.samples[k].grade, d: dStart };
      } else {
        cols[i] = { ele: eleSum / count, grade: gradeSum / count, d: dStart };
      }
    }
    this._cols = cols;
  }

  draw() {
    const { ctx } = this;
    if (!this.w || !this.h) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.samples || !this.stats) return;
    if (!this._cols) this._buildColumns();

    const pad = { top: 14, bottom: 18 };
    const lo = this.stats.minEle;
    const hi = Math.max(this.stats.maxEle, lo + 20);
    const plotH = this.h - pad.top - pad.bottom;
    const yOf = (ele) => pad.top + plotH * (1 - (ele - lo) / (hi - lo));

    // Columnas de pendiente.
    for (let i = 0; i < this._cols.length; i++) {
      const c = this._cols[i];
      const y = yOf(c.ele);
      ctx.fillStyle = gradeColor(c.grade);
      ctx.globalAlpha = c.d <= this.progress ? 1 : 0.42;
      ctx.fillRect(i, y, 1.02, this.h - pad.bottom - y);
    }
    ctx.globalAlpha = 1;

    // Línea de cota.
    ctx.beginPath();
    for (let i = 0; i < this._cols.length; i++) {
      const y = yOf(this._cols[i].ele);
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // Marcas de kilómetro.
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    const km = this.stats.distance / 1000;
    const stepKm = km > 60 ? 10 : km > 25 ? 5 : km > 10 ? 2 : 1;
    for (let k = stepKm; k < km; k += stepKm) {
      const x = (k / km) * this.w;
      ctx.fillRect(x, pad.top, 1, plotH);
      ctx.fillText(`${k}`, x + 3, this.h - 5);
    }

    // Cursor de posición.
    const total = this.stats.distance;
    if (total > 0) {
      const x = (this.progress / total) * this.w;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 1, 0, 2, this.h - pad.bottom);
      ctx.beginPath();
      ctx.arc(x, yOf(this._sampleEle(this.progress)), 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Dedo arrastrando.
    if (this.hover !== null) {
      const x = (this.hover / total) * this.w;
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillRect(x - 0.5, 0, 1, this.h - pad.bottom);
      const ele = this._sampleEle(this.hover);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      const label = `${(this.hover / 1000).toFixed(1)} km · ${Math.round(ele)} m`;
      const tw = ctx.measureText(label).width + 10;
      const lx = Math.min(this.w - tw, Math.max(0, x - tw / 2));
      ctx.fillRect(lx, 0, tw, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 5, 11);
    }
  }

  _sampleEle(meters) {
    if (!this._cols?.length) return this.stats.minEle;
    const i = Math.max(0, Math.min(this._cols.length - 1,
      Math.floor((meters / this.stats.distance) * this._cols.length)));
    return this._cols[i].ele;
  }

  destroy() {
    this._ro?.disconnect();
  }
}
