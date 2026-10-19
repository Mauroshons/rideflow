/**
 * Servidor estático para desarrollo y para servir la app al iPad.
 *
 *   node tools/serve.mjs [puerto]
 *
 * Imprime las direcciones de la red local: en el iPad se abre una de ellas
 * en Safari y se añade a la pantalla de inicio.
 *
 * Aviso importante sobre HTTPS: los service workers y la instalación de la
 * PWA exigen un origen seguro, y "seguro" incluye localhost pero NO una IP
 * de la red local servida por http. Si abrís http://192.168.1.x:8080 en el
 * iPad, la app funciona pero no se instala ni cachea. Las dos salidas
 * limpias están en el README; la más simple es un túnel o un certificado
 * local con mkcert.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const port = Number(process.argv[2] ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = join(root, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));

  // Nadie sale del directorio del proyecto.
  if (!file.startsWith(root + sep) && file !== root) {
    res.writeHead(403).end('403');
    return;
  }

  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado');
    return;
  }

  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    // Durante el desarrollo, nada de caché: el service worker ya da
    // suficientes sorpresas por su cuenta.
    'cache-control': 'no-cache',
    'service-worker-allowed': '/',
  });
  createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => {
  console.log(`\nRideFlow servido en el puerto ${port}\n`);
  console.log(`  local        http://localhost:${port}`);
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  ${name.padEnd(12)} http://${a.address}:${port}`);
      }
    }
  }
  console.log('\nEn el iPad: abrir una de las direcciones de red en Safari →');
  console.log('Compartir → Añadir a pantalla de inicio.\n');
});
