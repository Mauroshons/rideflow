import { bounds as routeBounds, haversine } from '../geo.js';
import { gradeColor } from './profile.js';

/**
 * Envoltura fina sobre Leaflet.
 *
 * Leaflet llega por CDN y lo cachea el service worker. Si no está (primera
 * carga sin red), la app no se rompe: el mapa se degrada a un aviso y todo
 * lo demás —perfil, rodillo, grabación— sigue funcionando, que es lo que
 * de verdad importa cuando ya estás subido a la bici.
 */
export class RouteMap {
  constructor(el, { interactive = true } = {}) {
    this.el = el;
    this.available = typeof window.L !== 'undefined';
    this.layers = [];
    this.marker = null;
    this.drawing = false;
    this.drawPoints = [];
    this.onDrawChange = null;

    if (!this.available) {
      el.innerHTML =
        '<div class="map-fallback">El mapa necesita conexión la primera vez. ' +
        'El resto de la app funciona sin él.</div>';
      return;
    }

    this.map = L.map(el, {
      zoomControl: interactive,
      attributionControl: true,
      // El arrastre con un dedo compite con el scroll de la página en iPad;
      // en la pantalla de rodaje el mapa es sólo para mirar.
      dragging: interactive,
      tap: interactive,
    }).setView([-33.45, -70.66], 11);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© OpenStreetMap',
    }).addTo(this.map);

    this.map.on('click', (e) => {
      if (this.drawing) this.addDrawPoint(e.latlng.lat, e.latlng.lng);
    });
  }

  clear() {
    if (!this.available) return;
    for (const l of this.layers) this.map.removeLayer(l);
    this.layers = [];
    this.marker = null;
  }

  /**
   * Pinta la ruta coloreada por pendiente. Se trocea en segmentos de color
   * uniforme en vez de dibujar una polilínea por punto: con 1 300 puntos,
   * 1 300 capas de Leaflet dejan el iPad inservible.
   */
  show(route) {
    if (!this.available) return;
    this.clear();

    const pts = route.drawPoints ?? route.points;
    const samples = route.samples;

    // Mapeamos cada punto de dibujo a la pendiente de su muestra más cercana.
    const segments = [];
    let current = null;
    let si = 0;
    let acc = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) acc += haversine(pts[i - 1], pts[i]);
      while (si < samples.length - 1 && samples[si].dTotal < acc) si++;
      const color = gradeColor(samples[si].grade);
      if (!current || current.color !== color) {
        if (current) current.latlngs.push([pts[i].lat, pts[i].lon]);
        current = { color, latlngs: [[pts[i].lat, pts[i].lon]] };
        segments.push(current);
      } else {
        current.latlngs.push([pts[i].lat, pts[i].lon]);
      }
    }

    for (const seg of segments) {
      this.layers.push(
        L.polyline(seg.latlngs, { color: seg.color, weight: 5, opacity: 0.95 }).addTo(this.map)
      );
    }

    const first = pts[0];
    const last = pts[pts.length - 1];
    this.layers.push(dot(first, '#3fb27f', 'Salida').addTo(this.map));
    this.layers.push(dot(last, '#e05252', 'Meta').addTo(this.map));

    for (const w of route.waypoints ?? []) {
      this.layers.push(
        L.circleMarker([w.lat, w.lon], {
          radius: 4, color: '#fff', weight: 1.5, fillColor: '#1d1f24', fillOpacity: 1,
        })
          .bindTooltip(w.name, { direction: 'top' })
          .addTo(this.map)
      );
    }

    this.map.fitBounds(routeBounds(pts), { padding: [24, 24] });
  }

  /** Mueve el cursor del ciclista y, si se pidió, recentra. */
  setPosition(lat, lon, { follow = false } = {}) {
    if (!this.available || !Number.isFinite(lat)) return;
    if (!this.marker) {
      this.marker = L.circleMarker([lat, lon], {
        radius: 7, color: '#fff', weight: 2.5, fillColor: '#ffd23f', fillOpacity: 1,
      }).addTo(this.map);
      this.layers.push(this.marker);
    } else {
      this.marker.setLatLng([lat, lon]);
    }
    if (follow) this.map.panTo([lat, lon], { animate: true, duration: 0.4 });
  }

  invalidate() {
    // Leaflet mide el contenedor al crearse; si la vista estaba oculta,
    // mide cero y el mapa sale en gris hasta que se le avisa.
    if (this.available) setTimeout(() => this.map.invalidateSize(), 50);
  }

  /* ------------------------------ dibujo ------------------------------ */

  startDrawing() {
    if (!this.available) return;
    this.drawing = true;
    this.clear();
    this.drawPoints = [];
    this._redrawDraft();
  }

  stopDrawing() {
    this.drawing = false;
  }

  addDrawPoint(lat, lon, ele = null) {
    this.drawPoints.push({ lat, lon, ele });
    this._redrawDraft();
  }

  undoDrawPoint() {
    this.drawPoints.pop();
    this._redrawDraft();
  }

  clearDrawing() {
    this.drawPoints = [];
    this._redrawDraft();
  }

  _redrawDraft() {
    if (!this.available) return;
    for (const l of this.layers) this.map.removeLayer(l);
    this.layers = [];

    if (this.drawPoints.length > 1) {
      this.layers.push(
        L.polyline(this.drawPoints.map((p) => [p.lat, p.lon]), {
          color: '#ffd23f', weight: 4, dashArray: '6 5',
        }).addTo(this.map)
      );
    }
    this.drawPoints.forEach((p, i) => {
      const m = L.circleMarker([p.lat, p.lon], {
        radius: 6,
        color: '#fff',
        weight: 2,
        fillColor: i === 0 ? '#3fb27f' : '#ffd23f',
        fillOpacity: 1,
      }).addTo(this.map);
      m.bindTooltip(
        `Punto ${i + 1}${p.ele !== null ? ` · ${Math.round(p.ele)} m` : ' · sin altitud'}`,
        { direction: 'top' }
      );
      this.layers.push(m);
    });

    this.onDrawChange?.(this.drawPoints);
  }
}

function dot(p, color, label) {
  return L.circleMarker([p.lat, p.lon], {
    radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1,
  }).bindTooltip(label, { direction: 'top' });
}
