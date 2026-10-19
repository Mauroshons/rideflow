/**
 * Genera los iconos PNG de la PWA sin dependencias.
 *
 *   node tools/build-icons.mjs
 *
 * iOS no acepta SVG como apple-touch-icon, así que hacen falta PNG de
 * verdad. En lugar de arrastrar una librería de imagen, se escribe el PNG
 * a mano: cabecera, IHDR, IDAT comprimido con el zlib de Node y IEND. Son
 * cuarenta líneas y evita una dependencia que habría que mantener.
 *
 * El dibujo es el perfil de una subida, coloreado por pendiente igual que
 * en la app: lo que ves en el icono es lo que ves dentro.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'icons'), { recursive: true });

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba  width*height*4 */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // profundidad de bits
  ihdr[9] = 6;    // color RGBA
  // 10..12: compresión, filtro e interlazado, todos en 0

  // Cada fila va precedida por su byte de filtro; usamos 0 (sin filtro) y
  // dejamos que deflate haga el trabajo.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.subarray(y * width * 4, (y + 1) * width * 4)
      .forEach((v, i) => { raw[y * (1 + width * 4) + 1 + i] = v; });
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BG = hex('#12151b');
const RAMP = ['#4c8c5a', '#88a844', '#d4a53c', '#d97836', '#c94c3c'].map(hex);

/** Perfil normalizado: sube de izquierda a derecha con dos rellanos. */
function profile(t) {
  return (
    0.08 +
    0.74 * t ** 1.35 +
    0.05 * Math.sin(t * 7.2) +
    0.03 * Math.sin(t * 17)
  );
}

function render(size, { padding = 0.0 } = {}) {
  const px = new Uint8Array(size * size * 4);
  const inner = size * (1 - padding * 2);
  const off = size * padding;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let r = BG[0], g = BG[1], b = BG[2];

      const t = (x - off) / inner;
      const yy = (y - off) / inner;
      if (t >= 0 && t <= 1 && yy >= 0 && yy <= 1) {
        const h = profile(t);
        const top = 1 - h;
        if (yy >= top) {
          // Color por pendiente local, igual que las columnas del perfil.
          const slope = (profile(Math.min(1, t + 0.02)) - h) / 0.02;
          const k = Math.max(0, Math.min(RAMP.length - 1, Math.round(slope * 2.1)));
          [r, g, b] = RAMP[k];
          // Oscurecemos hacia abajo para dar algo de volumen.
          const depth = 1 - 0.32 * ((yy - top) / Math.max(0.001, 1 - top));
          r = Math.round(r * depth); g = Math.round(g * depth); b = Math.round(b * depth);
        }
        // Línea de cota en blanco, con un antialias barato de medio píxel.
        const dist = Math.abs(yy - top) * inner;
        const lw = Math.max(1.4, size / 64);
        if (dist < lw) {
          const a = 1 - dist / lw;
          r = Math.round(r + (245 - r) * a);
          g = Math.round(g + (245 - g) * a);
          b = Math.round(b + (245 - b) * a);
        }
      }

      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

const targets = [
  { name: 'icon-180.png', size: 180 },     // apple-touch-icon
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  // El icono maskable se recorta: hay que dejarle margen de seguridad.
  { name: 'icon-maskable-512.png', size: 512, padding: 0.16 },
];

for (const t of targets) {
  const png = encodePNG(t.size, t.size, render(t.size, { padding: t.padding ?? 0 }));
  writeFileSync(join(root, 'icons', t.name), png);
  console.log(`${t.name.padEnd(24)} ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
