/**
 * Lectura y escritura de GPX (y TCX de salida).
 * Deliberadamente tolerante: los archivos que la gente arrastra vienen
 * de Strava, Garmin Connect, Komoot, RideWithGPS y de editores a mano,
 * y cada uno usa un dialecto distinto del mismo esquema.
 */

/**
 * @param {string} xml
 * @returns {{name:string, points:Array<{lat:number,lon:number,ele:number,time:?string}>, waypoints:Array}}
 */
export function parseGPX(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('El archivo no es XML válido.');

  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'gpx') {
    throw new Error('No parece un GPX: falta el elemento raíz <gpx>.');
  }

  const text = (el, tag) => {
    const n = el.getElementsByTagName(tag)[0];
    return n ? n.textContent.trim() : '';
  };

  // Nombre: metadata > track > archivo
  const name =
    text(root.getElementsByTagName('metadata')[0] ?? root, 'name') ||
    text(root.getElementsByTagName('trk')[0] ?? root, 'name') ||
    'Ruta importada';

  const readPt = (el) => {
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const eleTxt = text(el, 'ele');
    const timeTxt = text(el, 'time');
    return {
      lat,
      lon,
      ele: eleTxt === '' ? 0 : parseFloat(eleTxt) || 0,
      time: timeTxt || null,
      hasEle: eleTxt !== '',
    };
  };

  // Preferimos trkpt; si no hay, rtept; si tampoco, wpt sueltos.
  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (nodes.length === 0) nodes = Array.from(doc.getElementsByTagName('rtept'));
  if (nodes.length === 0) nodes = Array.from(doc.getElementsByTagName('wpt'));

  const points = nodes.map(readPt).filter(Boolean);
  if (points.length < 2) {
    throw new Error('El GPX no contiene una traza utilizable (menos de 2 puntos).');
  }

  const waypoints = Array.from(doc.getElementsByTagName('wpt'))
    .map((el) => {
      const p = readPt(el);
      return p ? { ...p, name: text(el, 'name'), sym: text(el, 'sym') } : null;
    })
    .filter(Boolean);

  const withEle = points.filter((p) => p.hasEle).length;
  return {
    name,
    points,
    waypoints,
    hasElevation: withEle > points.length * 0.5,
  };
}

const esc = (s) =>
  String(s).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  );

/** Serializa una ruta a GPX 1.1 (traza, sin tiempos). */
export function buildGPX(name, points, { description = '' } = {}) {
  const body = points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${(
          p.ele ?? 0
        ).toFixed(1)}</ele></trkpt>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RideFlow" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(name)}</name>
    ${description ? `<desc>${esc(description)}</desc>` : ''}
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${body}
    </trkseg>
  </trk>
</gpx>
`;
}

/**
 * Serializa una sesión grabada a TCX con potencia y cadencia, que es lo
 * que Strava y Garmin Connect saben leer de verdad. Un GPX con
 * extensiones también sirve, pero el TCX no pierde nada.
 */
export function buildTCX(session) {
  const start = new Date(session.startedAt).toISOString();
  const trackpoints = session.samples
    .map((s) => {
      const t = new Date(session.startedAt + s.t * 1000).toISOString();
      return `          <Trackpoint>
            <Time>${t}</Time>
            ${
              Number.isFinite(s.lat)
                ? `<Position><LatitudeDegrees>${s.lat.toFixed(
                    7
                  )}</LatitudeDegrees><LongitudeDegrees>${s.lon.toFixed(
                    7
                  )}</LongitudeDegrees></Position>`
                : ''
            }
            <AltitudeMeters>${(s.ele ?? 0).toFixed(1)}</AltitudeMeters>
            <DistanceMeters>${s.dist.toFixed(1)}</DistanceMeters>
            ${Number.isFinite(s.hr) && s.hr > 0 ? `<HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>` : ''}
            ${Number.isFinite(s.cadence) ? `<Cadence>${Math.round(s.cadence)}</Cadence>` : ''}
            <Extensions>
              <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                <Speed>${(s.speed ?? 0).toFixed(2)}</Speed>
                <Watts>${Math.round(s.power ?? 0)}</Watts>
              </TPX>
            </Extensions>
          </Trackpoint>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${start}</Id>
      <Lap StartTime="${start}">
        <TotalTimeSeconds>${session.elapsed.toFixed(0)}</TotalTimeSeconds>
        <DistanceMeters>${session.distance.toFixed(1)}</DistanceMeters>
        <MaximumSpeed>${(session.maxSpeed ?? 0).toFixed(2)}</MaximumSpeed>
        <Calories>${Math.round(session.kJ ?? 0)}</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${trackpoints}
        </Track>
        <Extensions>
          <ns3:LX><ns3:AvgWatts>${Math.round(session.avgPower ?? 0)}</ns3:AvgWatts>
          <ns3:MaxWatts>${Math.round(session.maxPower ?? 0)}</ns3:MaxWatts></ns3:LX>
        </Extensions>
      </Lap>
      <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <Name>RideFlow</Name>
      </Creator>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

/** Dispara la descarga de un texto como archivo. */
export function download(filename, text, mime = 'application/gpx+xml') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
