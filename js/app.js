import { TrainerManager, ADAPTERS } from './trainer/index.js';
import { RideEngine } from './ride.js';
import { RouteMap } from './ui/map.js';
import { ProfileChart, gradeColor } from './ui/profile.js';
import * as Routes from './routes.js';
import { Settings, Sessions, storageEstimate, requestPersistence } from './store.js';
import { buildTCX, download } from './gpx.js';
import { fmt, buildProfile, profileStats } from './geo.js';
import { zoneFor } from './physics.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const app = {
  settings: Settings.load(),
  trainer: new TrainerManager(),
  engine: null,
  rideMap: null,
  createMap: null,
  profile: null,
  route: null,
  availability: {},
  wakeLock: null,
};

app.engine = new RideEngine(app.trainer);
Object.assign(app.trainer.rider, {
  riderKg: app.settings.riderKg,
  bikeKg: app.settings.bikeKg,
  crr: app.settings.crr,
  cda: app.settings.cda,
  difficulty: app.settings.difficulty,
  ftp: app.settings.ftp,
});

/* ------------------------------------------------------------------ *
 *  Navegación
 * ------------------------------------------------------------------ */

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  if (name === 'ride') app.rideMap?.invalidate();
  if (name === 'create') app.createMap?.invalidate();
  if (name === 'history') renderSessions();
  if (name === 'settings') renderStorage();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', kind === 'error');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3200);
}

/* ------------------------------------------------------------------ *
 *  Catálogo de rutas
 * ------------------------------------------------------------------ */

/** Miniatura del perfil para la tarjeta: SVG, que escala sin coste. */
function sparkline(samples, stats, width = 260, height = 44) {
  const n = 110;
  const lo = stats.minEle;
  const hi = Math.max(stats.maxEle, lo + 10);
  let path = '';
  const bars = [];
  for (let i = 0; i < n; i++) {
    const d = (i / (n - 1)) * stats.distance;
    let k = Math.floor((i / (n - 1)) * (samples.length - 1));
    k = Math.max(0, Math.min(samples.length - 1, k));
    const x = (i / (n - 1)) * width;
    const y = height - ((samples[k].ele - lo) / (hi - lo)) * (height - 4) - 2;
    path += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    bars.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(width / n + 0.6).toFixed(2)}" ` +
      `height="${(height - y).toFixed(1)}" fill="${gradeColor(samples[k].grade)}" opacity="0.8"/>`
    );
    void d;
  }
  return (
    `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">` +
    bars.join('') +
    `<path d="${path}" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="1.2"/></svg>`
  );
}

function routeCard(route) {
  const s = route.stats;
  const el = document.createElement('article');
  el.className = 'route-card';
  el.innerHTML = `
    <div>
      <div class="region">${escapeHtml(route.region ?? '')}</div>
      <h3>${escapeHtml(route.name)}</h3>
    </div>
    ${sparkline(route.samples, s)}
    <div class="facts">
      <div><b>${fmt.km(s.distance)}</b> <span>km</span></div>
      <div><b>+${s.gain}</b> <span>m</span></div>
      <div><b>${fmt.pct(s.avgGrade)}</b> <span>% medio</span></div>
      <div><b>${fmt.pct(s.maxGrade)}</b> <span>% máx</span></div>
    </div>
    <p class="desc">${escapeHtml(route.desc ?? '')}</p>
    <div class="tags">${(route.tags ?? []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
    <div class="card-actions">
      <button class="btn btn-primary" data-act="ride">Rodar</button>
      <button class="btn" data-act="export">GPX</button>
      ${route.builtIn ? '' : '<button class="btn btn-danger" data-act="delete">Borrar</button>'}
    </div>`;

  el.querySelector('[data-act="ride"]').addEventListener('click', () => openRide(route));
  el.querySelector('[data-act="export"]').addEventListener('click', () => {
    download(`${slug(route.name)}.gpx`, Routes.exportRoute(route));
  });
  el.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
    await Routes.deleteRoute(route.id);
    toast(`"${route.name}" borrada.`);
    renderRoutes();
  });
  return el;
}

async function renderRoutes() {
  const grid = $('#routeGrid');
  grid.innerHTML = '<p class="empty">Cargando rutas…</p>';
  try {
    const index = await Routes.loadBuiltInIndex();
    const builtIn = await Promise.all(index.map((r) => Routes.loadBuiltInRoute(r.id)));
    const user = await Routes.loadUserRoutes();
    grid.innerHTML = '';
    [...builtIn, ...user].forEach((r) => grid.appendChild(routeCard(r)));
    $('#routesHint').textContent =
      `${builtIn.length} rutas precargadas` +
      (user.length ? ` y ${user.length} tuya${user.length > 1 ? 's' : ''}.` : '. Importá las tuyas desde Archivos o dibujalas en el mapa.');
  } catch (err) {
    grid.innerHTML = `<p class="empty">No se pudieron cargar las rutas: ${escapeHtml(err.message)}</p>`;
  }
}

$('#gpxInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files ?? []);
  e.target.value = '';
  for (const f of files) {
    try {
      const route = await Routes.importGPXFile(f);
      toast(route.warning ?? `"${route.name}" importada: ${fmt.km(route.stats.distance)} km.`,
            route.warning ? 'error' : 'info');
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 'error');
    }
  }
  renderRoutes();
});

/* ------------------------------------------------------------------ *
 *  Pantalla de rodaje
 * ------------------------------------------------------------------ */

function openRide(route) {
  app.route = route;
  app.engine.load(route, route.samples);

  $('#rideEmpty').hidden = true;
  $('#rideBody').hidden = false;
  $('#rideRouteName').textContent = route.name;

  if (!app.rideMap) app.rideMap = new RouteMap($('#rideMap'), { interactive: false });
  app.rideMap.show(route);
  app.rideMap.setPosition(route.points[0].lat, route.points[0].lon);

  if (!app.profile) {
    app.profile = new ProfileChart($('#profileCanvas'), {
      onSeek: (m) => app.engine.seek(m),
    });
  }
  app.profile.load(route.samples, route.stats);

  showView('ride');
  app.rideMap.invalidate();
  updateRideUI(app.engine.snapshot());
  setControls('idle');

  if (!app.trainer.connected) {
    toast('No hay rodillo conectado. Conectalo en Ajustes o usá el simulador.', 'error');
  }
}

function setControls(state) {
  $('#btnStart').textContent = state === 'paused' ? 'Continuar' : 'Empezar';
  $('#btnStart').disabled = state === 'running' || state === 'finished';
  $('#btnPause').disabled = state !== 'running';
  $('#btnLap').disabled = state !== 'running';
  $('#btnFinish').disabled = state === 'idle';
}

function updateRideUI(s) {
  $('#mPower').textContent = Math.round(s.power);
  $('#mCadence').textContent = Math.round(s.cadence);
  $('#mGrade').textContent = fmt.pct(s.grade).replace('.', ',');
  $('#mSpeed').textContent = fmt.speed(s.speed).replace('.', ',');
  $('#mHr').textContent = s.hr ? Math.round(s.hr) : '—';

  const zone = zoneFor(s.power, app.settings.ftp);
  $('#mPower').style.color = s.power > 0 ? zone.color : '';
  $('#mZone').textContent = s.power > 0 ? zone.key.toUpperCase() : '';
  $('#mZone').style.color = zone.color;

  $('#sDist').textContent = fmt.km(s.distance).replace('.', ',');
  $('#sRemain').textContent = fmt.km(s.remaining).replace('.', ',');
  $('#sTime').textContent = fmt.hhmmss(s.elapsed);
  $('#sEta').textContent = s.eta ? fmt.hhmmss(s.eta) : '—';
  $('#sEle').textContent = Math.round(s.ele);
  $('#sAvg').textContent = Math.round(s.avgPower);
  $('#sNp').textContent = Math.round(s.np);
  $('#sKj').textContent = Math.round(s.kJ);
  $('#progressFill').style.width = `${(s.progress * 100).toFixed(2)}%`;

  app.profile?.setProgress(s.distance);
  app.rideMap?.setPosition(s.lat, s.lon, { follow: $('#followToggle').checked });
}

app.engine.addEventListener('tick', (e) => updateRideUI(e.detail));
app.engine.addEventListener('state', (e) => setControls(e.detail));
app.engine.addEventListener('reset', () => updateRideUI(app.engine.snapshot()));

app.engine.addEventListener('finished', async (e) => {
  setControls('finished');
  await saveSession(e.detail);
  toast(`¡Ruta terminada! ${fmt.km(e.detail.distance)} km en ${fmt.hhmmss(e.detail.elapsed)}.`);
  releaseWakeLock();
});

app.engine.addEventListener('lap', (e) => {
  toast(`Vuelta ${app.engine.laps.length}: ${fmt.km(e.detail.distance)} km.`);
});

$('#btnStart').addEventListener('click', async () => {
  if (!app.trainer.connected) {
    toast('Conectá un rodillo (o el simulador) antes de empezar.', 'error');
    showView('settings');
    return;
  }
  app.engine.start();
  await requestWakeLock();
});

$('#btnPause').addEventListener('click', () => {
  app.engine.pause();
  releaseWakeLock();
});

$('#btnLap').addEventListener('click', () => app.engine.lap());

$('#btnFinish').addEventListener('click', async () => {
  const session = app.engine.session();
  app.engine.pause();
  app.engine.stop();
  if (session.elapsed > 30) {
    await saveSession(session);
    toast(`Sesión guardada: ${fmt.km(session.distance)} km.`);
  } else {
    toast('Sesión descartada por ser demasiado corta.');
  }
  app.engine.reset();
  setControls('idle');
  releaseWakeLock();
});

$$('.seg[data-mode]').forEach((b) => {
  b.addEventListener('click', () => {
    $$('.seg[data-mode]').forEach((x) => x.classList.toggle('is-active', x === b));
    const mode = b.dataset.mode;
    app.trainer.setMode(mode);
    $('#ergWrap').hidden = mode !== 'erg';
    $('#resWrap').hidden = mode !== 'resistance';
    if (mode === 'erg') app.trainer.setTargetPower(Number($('#ergRange').value));
    if (mode === 'resistance') app.trainer.setResistance(Number($('#resRange').value));
  });
});

$('#ergRange').addEventListener('input', (e) => {
  $('#ergValue').textContent = e.target.value;
  app.trainer.setTargetPower(Number(e.target.value));
});

$('#resRange').addEventListener('input', (e) => {
  $('#resValue').textContent = e.target.value;
  app.trainer.setResistance(Number(e.target.value));
});

$('#simRange').addEventListener('input', (e) => {
  $('#simValue').textContent = e.target.value;
  app.trainer.setSimEffort(Number(e.target.value) / 100);
});

/* ------------------------------------------------------------------ *
 *  Crear ruta
 * ------------------------------------------------------------------ */

function initCreateMap() {
  if (app.createMap) return;
  app.createMap = new RouteMap($('#createMap'));
  app.createMap.onDrawChange = renderDraftPoints;
  app.createMap.startDrawing();
}

function renderDraftPoints(points) {
  const list = $('#pointList');
  list.innerHTML = '';
  points.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="idx">${i + 1}</span>
      <input type="number" step="1" placeholder="m" value="${p.ele ?? ''}" aria-label="Altitud del punto ${i + 1}">
      <span class="coord">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</span>`;
    li.querySelector('input').addEventListener('input', (e) => {
      const v = e.target.value === '' ? null : Number(e.target.value);
      points[i].ele = Number.isFinite(v) ? v : null;
      updateDraftSummary(points);
    });
    list.appendChild(li);
  });
  updateDraftSummary(points);
}

function updateDraftSummary(points) {
  const box = $('#createSummary');
  if (points.length < 2) {
    box.textContent = points.length === 0
      ? 'Sin puntos todavía.'
      : 'Un punto. Hace falta al menos otro más.';
    return;
  }
  // Interpolamos las cotas que falten para poder dar un resumen ya mismo.
  const filled = fillElevations(points);
  try {
    const st = profileStats(buildProfile(filled));
    const known = points.filter((p) => p.ele !== null).length;
    box.textContent =
      `${points.length} puntos · ${fmt.km(st.distance)} km · +${st.gain} m · ` +
      `${fmt.pct(st.avgGrade)} % medio` +
      (known < points.length ? ` · ${points.length - known} sin altitud (interpoladas)` : '');
  } catch (err) {
    box.textContent = err.message;
  }
}

/**
 * Rellena las altitudes que falten interpolando entre las conocidas.
 * Si no hay ninguna, la ruta queda llana y se avisa: es preferible a
 * inventarse un perfil que el usuario no pidió.
 */
function fillElevations(points) {
  const out = points.map((p) => ({ ...p }));
  const known = out.map((p, i) => (p.ele !== null && Number.isFinite(p.ele) ? i : -1)).filter((i) => i >= 0);
  if (known.length === 0) return out.map((p) => ({ ...p, ele: 0 }));

  for (let i = 0; i < out.length; i++) {
    if (out[i].ele !== null && Number.isFinite(out[i].ele)) continue;
    const before = known.filter((k) => k < i).pop();
    const after = known.find((k) => k > i);
    if (before === undefined) out[i].ele = out[after].ele;
    else if (after === undefined) out[i].ele = out[before].ele;
    else {
      const t = (i - before) / (after - before);
      out[i].ele = out[before].ele + (out[after].ele - out[before].ele) * t;
    }
  }
  return out;
}

$('#btnUndoPoint').addEventListener('click', () => app.createMap?.undoDrawPoint());
$('#btnClearPoints').addEventListener('click', () => app.createMap?.clearDrawing());

$('#btnSaveRoute').addEventListener('click', async () => {
  const points = app.createMap?.drawPoints ?? [];
  if (points.length < 2) {
    toast('Poné al menos dos puntos en el mapa.', 'error');
    return;
  }
  try {
    const route = await Routes.createRoute({
      name: $('#newRouteName').value.trim() || 'Ruta nueva',
      desc: $('#newRouteDesc').value.trim(),
      points: fillElevations(points),
    });
    toast(`"${route.name}" guardada: ${fmt.km(route.stats.distance)} km.`);
    app.createMap.clearDrawing();
    $('#newRouteName').value = '';
    $('#newRouteDesc').value = '';
    await renderRoutes();
    showView('routes');
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ------------------------------------------------------------------ *
 *  Historial
 * ------------------------------------------------------------------ */

async function saveSession(session) {
  try {
    await Sessions.add(session);
  } catch (err) {
    toast(`No se pudo guardar la sesión: ${err.message}`, 'error');
  }
}

async function renderSessions() {
  const list = $('#sessionList');
  const sessions = await Sessions.all();
  if (sessions.length === 0) {
    list.innerHTML = '<p class="empty">Todavía no hay sesiones grabadas.</p>';
    return;
  }
  list.innerHTML = '';
  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = 'session';
    el.innerHTML = `
      <div class="title">${escapeHtml(s.routeName)}
        <div class="when">${new Date(s.startedAt).toLocaleString('es-CL')}</div>
      </div>
      <div class="nums">
        <div><b>${fmt.km(s.distance)}</b> <span>km</span></div>
        <div><b>${fmt.hhmmss(s.elapsed)}</b></div>
        <div><b>+${s.gain}</b> <span>m</span></div>
        <div><b>${Math.round(s.avgPower)}</b> <span>W med</span></div>
        <div><b>${Math.round(s.np)}</b> <span>W NP</span></div>
        ${s.tss ? `<div><b>${Math.round(s.tss)}</b> <span>TSS</span></div>` : ''}
      </div>
      <div class="acts">
        <button class="btn" data-act="tcx">TCX</button>
        <button class="btn btn-danger" data-act="del">Borrar</button>
      </div>`;
    el.querySelector('[data-act="tcx"]').addEventListener('click', () => {
      download(`${slug(s.routeName)}-${new Date(s.startedAt).toISOString().slice(0, 10)}.tcx`,
               buildTCX(s), 'application/vnd.garmin.tcx+xml');
    });
    el.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await Sessions.remove(s.id);
      renderSessions();
    });
    list.appendChild(el);
  }
}

/* ------------------------------------------------------------------ *
 *  Ajustes y conexión
 * ------------------------------------------------------------------ */

async function renderAdapters() {
  app.availability = await TrainerManager.availability();
  const box = $('#adapterList');
  box.innerHTML = '';
  for (const A of ADAPTERS) {
    const usable = app.availability[A.id];
    const label = document.createElement('label');
    label.className = `adapter${app.settings.adapter === A.id ? ' is-selected' : ''}${usable ? '' : ' is-unavailable'}`;
    label.innerHTML = `
      <input type="radio" name="adapter" value="${A.id}" ${app.settings.adapter === A.id ? 'checked' : ''} ${usable ? '' : 'disabled'}>
      <span class="meta"><b>${escapeHtml(A.label)}</b><small>${escapeHtml(A.blurb)}</small>
      ${usable ? '' : '<small style="color:var(--bad)">No disponible en este navegador.</small>'}</span>`;
    label.querySelector('input').addEventListener('change', () => {
      app.settings = Settings.save({ adapter: A.id });
      renderAdapters();
    });
    box.appendChild(label);
  }

  const showAll = $('#showAllDevices');
  showAll.checked = !!app.settings.showAllDevices;
  showAll.onchange = () => { app.settings = Settings.save({ showAllDevices: showAll.checked }); };

  $('#bridgeUrl').value = app.settings.bridgeUrl;
  const needsBridge = app.settings.adapter === 'bridge';
  $('#bridgeUrl').closest('.field').style.display = needsBridge ? '' : 'none';

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('#adapterHint').textContent = !navigator.bluetooth
    ? (ios
      ? 'Safari no implementa Web Bluetooth, así que en iPad el rodillo se controla por Puente (un equipo cercano hace de intermediario) o se usa el Simulador. Mirá docs/PUENTE.md.'
      : 'Este navegador no expone Web Bluetooth. Probá con Chrome o Edge, o usá el Puente.')
    : 'Encendé el rodillo y pedaleá un par de segundos antes de conectar: muchos no anuncian hasta que detectan movimiento.';
}

$('#btnConnect').addEventListener('click', async () => {
  const id = app.settings.adapter;
  const btn = $('#btnConnect');
  btn.disabled = true;
  btn.textContent = 'Conectando…';
  try {
    await app.trainer.connect(id, {
      url: $('#bridgeUrl').value.trim(),
      ftp: app.settings.ftp,
      showAllDevices: $('#showAllDevices').checked,
    });
    app.settings = Settings.save({ bridgeUrl: $('#bridgeUrl').value.trim() });
    toast(`Conectado: ${app.trainer.adapter.deviceName}.`);
    await requestPersistence();
  } catch (err) {
    toast(connectErrorMessage(err, id), 'error');
    app.trainer._onLog({ message: `${err.name}: ${err.message}`, level: 'error', at: Date.now() });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Conectar';
  }
});

/**
 * Traduce el fallo de Web Bluetooth a algo que se pueda accionar. Los
 * mensajes que da Chrome son correctos y completamente inútiles para alguien
 * que está encima de la bici queriendo empezar.
 */
function connectErrorMessage(err, adapterId) {
  const bluetoothAdapter = adapterId === 'ftms' || adapterId === 'tacx-fec';

  if (err.name === 'NotFoundError' && /cancel/i.test(err.message)) {
    return $('#showAllDevices').checked
      ? 'Conexión cancelada.'
      : 'Conexión cancelada. Si el rodillo no salía en la lista, marcá "Mostrar todos los dispositivos".';
  }
  if (err.name === 'NotFoundError' && bluetoothAdapter) {
    return 'No apareció ningún rodillo. Encendelo, pedaleá un par de segundos y marcá ' +
      '"Mostrar todos los dispositivos" si sigue sin salir.';
  }
  if (err.name === 'SecurityError') {
    return 'El navegador bloqueó el Bluetooth. La app tiene que estar servida desde ' +
      'localhost o por HTTPS: usá start.cmd en vez de abrir el archivo directamente.';
  }
  if (err.name === 'NetworkError') {
    return 'Se cortó la conexión al conectar. Suele pasar si el rodillo ya está ' +
      'emparejado con otra app o con el móvil: cerrá la otra y volvé a probar.';
  }
  if (err.name === 'NotSupportedError') {
    return 'El rodillo rechazó una operación que decía soportar. Mirá el registro ' +
      'en Diagnóstico y probá con el otro adaptador Bluetooth.';
  }
  return err.message;
}

$('#btnDisconnect').addEventListener('click', async () => {
  await app.trainer.disconnect();
  toast('Rodillo desconectado.');
});

$('#connChip').addEventListener('click', () => showView('settings'));

$('#btnTestRamp').addEventListener('click', async () => {
  if (!app.trainer.connected) {
    toast('Conectá primero.', 'error');
    return;
  }
  toast('Rampa de prueba: diez escalones de 0 a 10 % en 20 s.');
  for (let i = 0; i <= 10; i++) {
    app.trainer.requestSlope(i / 100);
    await sleep(2000);
  }
  app.trainer.requestSlope(0);
  toast('Rampa terminada.');
});

$('#btnClearLog').addEventListener('click', () => {
  app.trainer.logs.length = 0;
  $('#logBox').textContent = '';
});

/* Campos del ciclista: cada uno escribe en los ajustes y en el modelo. */
const bindNumber = (sel, key, onChange) => {
  const el = $(sel);
  el.value = app.settings[key];
  el.addEventListener('change', () => {
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    app.settings = Settings.save({ [key]: v });
    app.trainer.setRider({ [key]: v });
    onChange?.(v);
  });
};

bindNumber('#setRiderKg', 'riderKg');
bindNumber('#setBikeKg', 'bikeKg');
bindNumber('#setFtp', 'ftp', (v) => {
  if (app.trainer.adapter?.constructor.id === 'sim') app.trainer.adapter.ftp = v;
});
bindNumber('#setCrr', 'crr');
bindNumber('#setCda', 'cda');

const diff = $('#setDifficulty');
diff.value = Math.round(app.settings.difficulty * 100);
$('#diffValue').textContent = diff.value;
diff.addEventListener('input', () => {
  $('#diffValue').textContent = diff.value;
  const v = Number(diff.value) / 100;
  app.settings = Settings.save({ difficulty: v });
  app.trainer.setRider({ difficulty: v });
});

async function renderStorage() {
  const est = await storageEstimate();
  $('#storageHint').textContent = est
    ? `Almacenamiento usado: ${(est.usage / 1e6).toFixed(1)} MB de ${(est.quota / 1e6).toFixed(0)} MB.`
    : '';
}

/* ------------------------------------------------------------------ *
 *  Estado del rodillo en la barra superior
 * ------------------------------------------------------------------ */

function renderConn() {
  const chip = $('#connChip');
  const t = app.trainer;
  chip.classList.toggle('is-on', t.connected);
  chip.classList.toggle('is-off', !t.connected);
  chip.classList.toggle('is-stale', t.connected && t.metrics.stale);
  $('#connText').textContent = !t.connected
    ? 'Sin rodillo'
    : t.metrics.stale
      ? `${t.adapter.deviceName} · sin datos`
      : `${t.adapter.deviceName} · ${Math.round(t.metrics.power)} W`;
}

app.trainer.addEventListener('status', (e) => {
  renderConn();
  const isSim = app.trainer.adapter?.constructor.id === 'sim';
  $('#simWrap').hidden = !(isSim && e.detail.connected);
});
app.trainer.addEventListener('data', renderConn);

app.trainer.addEventListener('log', (e) => {
  const box = $('#logBox');
  const t = new Date(e.detail.at).toLocaleTimeString('es-CL');
  box.textContent += `[${t}] ${e.detail.message}\n`;
  box.scrollTop = box.scrollHeight;
});

/* ------------------------------------------------------------------ *
 *  Pantalla encendida
 * ------------------------------------------------------------------ */

async function requestWakeLock() {
  if (!app.settings.keepAwake || !navigator.wakeLock) return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // iOS 16.4+ lo soporta; en versiones previas no hay nada que hacer
    // salvo subir el tiempo de bloqueo en Ajustes del iPad.
  }
}

function releaseWakeLock() {
  app.wakeLock?.release?.().catch(() => {});
  app.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.engine.state === 'running') requestWakeLock();
});

/* ------------------------------------------------------------------ *
 *  Utilidades
 * ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slug(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ruta';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 *  Arranque
 * ------------------------------------------------------------------ */

async function boot() {
  initCreateMap();
  await renderAdapters();
  await renderRoutes();
  renderConn();

  // Arrastrar y soltar un GPX sobre la ventana, para el escritorio.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /\.gpx$/i.test(f.name));
    for (const f of files) {
      try {
        const r = await Routes.importGPXFile(f);
        toast(`"${r.name}" importada.`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    if (files.length) renderRoutes();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Sin service worker la app sigue funcionando; sólo pierde el modo
      // sin conexión. No vale la pena molestar al usuario con esto.
    });
  }
}

boot();

// Para depurar desde la consola del inspector.
window.rideflow = app;
