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

/**
 * Las direcciones IPv4 de este equipo, ordenadas por lo probable que es que
 * sean la buena.
 *
 * Un PC cualquiera tiene más direcciones de las que uno cree: adaptadores
 * virtuales de VMware o VirtualBox, conmutadores de Hyper-V, y direcciones
 * 169.254.x que Windows se inventa cuando una interfaz no consiguió DHCP y
 * que no encaminan a ninguna parte. Ofrecerlas todas en pie de igualdad es
 * pedirle al usuario que acierte de cuatro, así que las marcamos.
 */
function localAddresses() {
  const virtual = /vmware|virtualbox|vbox|hyper-v|vethernet|loopback|tailscale|zerotier|docker/i;
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const linkLocal = a.address.startsWith('169.254.');
      out.push({
        interface: name,
        address: a.address,
        likely: !linkLocal && !virtual.test(name),
        why: linkLocal ? 'sin DHCP, no encamina' : virtual.test(name) ? 'adaptador virtual' : null,
      });
    }
  }
  // Las probables primero; entre ellas, el WiFi antes que el resto, porque
  // el iPad va por WiFi y conviene que compartan red.
  const rank = (a) => (a.likely ? 0 : 2) + (/wi-?fi|wlan|wireless/i.test(a.interface) ? -1 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  // La página del proveedor pregunta por aquí qué dirección tiene que abrir
  // el iPad. El navegador no puede saberlo, y hacer que el usuario la
  // busque a mano es la forma más fácil de que se equivoque de interfaz.
  if (urlPath === '/__net') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ port, addresses: localAddresses() }));
    return;
  }

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
  for (const a of localAddresses()) {
    const tag = a.likely ? '' : `   (${a.why})`;
    console.log(`  ${a.interface.padEnd(14).slice(0, 14)} http://${a.address}:${port}${tag}`);
  }
  console.log('\nEn el iPad: abrir una de las direcciones de red en Safari →');
  console.log('Compartir → Añadir a pantalla de inicio.\n');
});
