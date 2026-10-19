# RideFlow

Entrenador indoor con rutas GPX y control de rodillo: cargás una ruta, el
rodillo reproduce su perfil y la app graba lo que hiciste.

Sin framework, sin paso de compilación, sin dependencias en tiempo de
ejecución salvo Leaflet para el mapa. Son archivos estáticos: cualquier
servidor los sirve y el navegador los ejecuta tal cual.

## Empezá por aquí: en el PC, con doble clic

```
start.cmd
```

Eso levanta el servidor y abre la app en Chrome o Edge. Para conectar el
rodillo: **Ajustes → Rodillo → Rodillo Bluetooth (FTMS) → Conectar**. Si el
Tacx no sale en el selector, volvé y probá **Tacx FE-C**.

Para que quede como una aplicación de verdad —icono propio, ventana sin barra
de direcciones, arranque sin red— abrí el menú del navegador e **Instalar
RideFlow**.

---

## Por qué el PC y no el iPad

Las dos vías funcionan, pero no cuestan lo mismo.

| | **PC con Chrome/Edge** | **iPad instalado** |
|---|---|---|
| Conexión al rodillo | Directa, Bluetooth del propio equipo | Necesita un puente: otro equipo con Bluetooth encendido al lado |
| Piezas en marcha | Una: el navegador | Tres: iPad, puente y rodillo |
| Puntos de fallo | El Bluetooth | El Bluetooth, el WiFi y el puente |
| Instalable | Sí, como PWA | Sí, a pantalla de inicio |
| Preparación | Doble clic | Instalar Node en el equipo puente, dejarlo arrancando y fijar su IP |

**La vía conveniente es el PC.** No porque el iPad sea peor pantalla —es mejor—
sino porque en el PC el Bluetooth está a un clic y en el iPad hace falta un
intermediario que hay que mantener encendido. Si acabás queriendo el iPad en el
manillar, el puente ya está implementado y documentado en
[docs/PUENTE.md](docs/PUENTE.md); el propio PC puede hacer de puente.

### Por qué el iPad necesita puente

**Safari no implementa Web Bluetooth.** En iPad —y en iPhone, y en el Safari de
macOS— no existe la API, y como iOS obliga a todos los navegadores a usar
WebKit, instalar Chrome allí no cambia nada. No es un fallo de esta app ni algo
que se arregle con permisos.

| Dónde | Rodillo real | Cómo |
|---|---|---|
| **Chrome / Edge en PC** | **sí, directo** | Web Bluetooth: FTMS o Tacx FE-C |
| Android Chrome | sí, directo | Igual que en escritorio |
| iPad instalado | sí, vía puente | Un equipo cercano pone el Bluetooth |
| iPad instalado | no, simulado | Simulador integrado, para probar rutas y perfiles |

Todo lo demás —mapas, GPX, creación de rutas, perfil, grabación, exportación,
funcionamiento sin red— es nativo en iPad y no depende de nada de esto.

### Requisitos reales del PC

- Radio Bluetooth 4.0 o posterior. Casi cualquier portátil de la última década
  la tiene; un sobremesa puede necesitar un adaptador USB de 10 €.
- Chrome o Edge. **Firefox no sirve**: no implementa Web Bluetooth y no tiene
  intención de hacerlo.
- La app servida desde `localhost`. Es lo que hace `start.cmd`, y no es un
  detalle menor: Web Bluetooth y la instalación de la PWA exigen un origen
  seguro. `localhost` cuenta aunque sea `http`; una IP de red local, no.

### Si preferís el iPad

```bash
node tools/serve.mjs
```

Abrí en Safari la dirección de red que imprime el servidor →
**Compartir → Añadir a pantalla de inicio**. Para el rodillo, levantá el puente
en el PC y apuntá el iPad a su IP ([docs/PUENTE.md](docs/PUENTE.md)).

---

## Las cinco rutas que vienen cargadas

| Ruta | Dónde | Distancia | Desnivel | Media | Para qué |
|---|---|---|---|---|---|
| Subida a Farellones | Santiago | 32,0 km | +1440 m | 4,5 % | Resistencia en subida, largo |
| Cuesta Barriga | R. Metropolitana | 12,0 km | +525 m | 4,4 % | Umbral |
| Cajón del Maipo | San José de Maipo | 30,0 km | +475 m | 1,6 % | Fondo en Z2 |
| Alpe d'Huez | Isère, Francia | 13,8 km | +1130 m | 8,2 % | La referencia universal |
| Costanera Viña — Concón | Valparaíso | 14,0 km | +59 m | 0,4 % | Series en llano |

Cómo están hechas, con honestidad: las coordenadas son anclas reales de cada
carretera y las cotas son las reales de esos puntos, pero el trazado entre
anclas se interpola con un spline y la longitud se ajusta a la real de cada
puerto mediante lacetas calculadas
([`tools/build-routes.mjs`](tools/build-routes.mjs)). Las cifras que importan
para entrenar —distancia, desnivel, pendiente media y máxima— coinciden con las
del puerto de verdad. El dibujo sobre el mapa es fiel en su recorrido general,
no curva por curva. Si querés la traza exacta, bajá el GPX de Strava e
importalo: tarda dos segundos.

Para regenerarlas o añadir las tuyas, editá
[`data/route-sources.json`](data/route-sources.json) y:

```bash
npm run routes
```

---

## Qué hace

**Rutas.** Importa GPX de Strava, Garmin, Komoot o RideWithGPS; los dibuja
sobre el mapa coloreados por pendiente; los guarda en IndexedDB. También podés
dibujar una ruta tocando el mapa y asignarle cotas a cada punto.

**Rodaje.** El perfil se recorre integrando la potencia medida contra la
pendiente del tramo, igual que hace cualquier simulador serio — no con la
velocidad que informa el rodillo, que es la de su volante y depende del
desarrollo que lleves puesto. Tres modos: pendiente (sigue el GPX), ERG
(potencia fija) y resistencia fija.

**Medición.** Potencia con zonas por color, cadencia, pulso, velocidad virtual,
potencia normalizada, IF y TSS. La grabación va a 1 Hz y se exporta en TCX con
posiciones, vatios y cadencia, que es lo que Strava y Garmin Connect leen sin
rechistar.

**Sin red.** El service worker cachea la app entera y las cinco rutas; los
azulejos del mapa se guardan a medida que los vas viendo, con un tope de 600.
Un garaje con WiFi malo no es excusa para quedarse sin entrenar.

---

## Rodillos

La app no habla Bluetooth directamente: pide «ponme un 7 % de pendiente» y un
adaptador decide cómo se dice eso.

- **FTMS** (`0x1826`), el estándar abierto. Es la vía preferente con cualquier
  rodillo moderno. Si el aparato sólo expone Cycling Power (`0x1818`), la app
  se degrada a medidor: lee potencia y cadencia pero no controla resistencia.
- **Tacx FE-C sobre BLE.** Los Tacx de la generación Flow / Vortex / Bushido
  Smart transportan mensajes ANT+ FE-C enteros, trama incluida, por el
  servicio `6e40fec1-…`. Por dentro siguen hablando ANT+; sólo cambia el
  transporte. Implementadas las páginas 48 (resistencia), 49 (potencia
  objetivo), 51 (resistencia de recorrido — la del modo pendiente), 55
  (configuración de usuario) y 70 (petición de página), más la decodificación
  de las páginas 16 y 25.
- **Puente en red local.** Ver arriba.
- **Simulador.** Un ciclista modelado con variabilidad e inercia realistas.

### Sobre el Tacx Flow en concreto

Es un rodillo de rueda, y su potencia es **estimada** a partir de la curva del
freno y la velocidad de la rueda, no medida en el eje. Depende de cuánto
aprietes el rodillo contra la cubierta, de la presión del neumático y de la
temperatura. Dos consecuencias prácticas:

1. Calibralo (spin-down) después de 10 minutos rodando, siempre con la misma
   presión de rodillo. La app avisa cuando el propio Tacx pide calibración.
2. No esperes que coincida con un medidor de potencia real. Para entrenar por
   zonas da igual, siempre que tu FTP esté medido **con el mismo rodillo**.

También conviene saber que no todos los Flow exponen FTMS: depende del
firmware. Si el adaptador FTMS no encuentra el servicio, probá con el de FE-C.

---

## Ajustes que de verdad cambian algo

**Dificultad de pendiente.** Al 50 %, una rampa del 12 % llega al rodillo como
un 6 %. No es hacer trampa: si tu desarrollo más corto es un 34×28, en un 12 %
real a 60 rpm te quedás clavado. Bajar la dificultad conserva la forma del
perfil —las rampas siguen siendo rampas y los descansos siguen siendo
descansos— y la hace rodable.

**CdA y Crr.** Afectan a la velocidad virtual, no a lo que sentís en las
piernas. 0,32 de CdA equivale a manos en la parte alta del manillar; 0,25, a
posición aero. Subirlos te hace ir más lento con los mismos vatios.

**FTP.** Se usa para los colores de zona, el IF y el TSS. Si está mal, esos tres
están mal; todo lo demás sigue siendo correcto.

---

## Estructura

```
index.html              una sola página, cinco vistas
js/
  app.js                cableado de la interfaz
  geo.js                haversine, suavizado, pendientes, Douglas-Peucker
  gpx.js                lectura de GPX, escritura de GPX y TCX
  physics.js            modelo del ciclista, zonas, potencia normalizada
  ride.js               motor de sesión: avance, consignas, grabación
  routes.js             catálogo y persistencia de rutas
  store.js             IndexedDB y ajustes
  trainer/
    base.js             contrato de los adaptadores
    protocol.js         FTMS y ANT+ FE-C, codificación y decodificación
    ftms.js  tacx.js  bridge.js  sim.js
    index.js            gestor: ritmo de escritura, dificultad, telemetría
  ui/
    map.js              Leaflet
    profile.js          perfil en canvas, coloreado por pendiente
data/
  route-sources.json    anclas de las rutas precargadas
  routes/*.gpx          generados
tools/
  build-routes.mjs      spline + PCHIP + lacetas → GPX
  build-icons.mjs       PNG escritos a mano, sin dependencias
  bridge-server.mjs     puente WebSocket ↔ BLE/ANT+
  serve.mjs             servidor estático
  check.mjs             pruebas de protocolo, física y geometría
```

```bash
npm run check     # pruebas de los módulos puros
npm run build     # regenera rutas e iconos
```

Las pruebas comprueban lo que de verdad se rompe en silencio: que un 8 % de
pendiente se codifique como `0x5140` en la página 51 de FE-C, que el bit 0 de
los flags de FTMS tenga la semántica invertida que marca la especificación,
que 250 W en llano den 36-38 km/h y no 50, y que un paquete truncado no tumbe
la sesión.

---

## Detalles de iOS que cuesta descubrir

- **Hay que instalarla.** En iOS, el almacenamiento de un sitio web se borra
  tras siete días sin visitarlo. Una PWA añadida a la pantalla de inicio queda
  exenta de esa purga. Si la usás desde Safari sin instalar, tus rutas y
  sesiones pueden desaparecer solas.
- **Service worker y origen seguro.** Instalar la PWA exige HTTPS o
  `localhost`. Una IP de red local servida por `http://` **no** cuenta: la app
  funciona, pero no se instala ni cachea. Para resolverlo hay dos vías
  limpias: un certificado local con [mkcert](https://github.com/FiloSottile/mkcert),
  o un túnel. La más cómoda a largo plazo es publicarla en cualquier hosting
  estático y apuntar el puente a la red local.
- **Pantalla encendida.** La app pide un *wake lock*, soportado desde iOS
  16.4. En versiones anteriores, subí el bloqueo automático en los ajustes del
  iPad.
- **Orientación.** El manifest pide horizontal, pero iOS lo ignora. La interfaz
  se adapta igual a vertical: la barra lateral se pliega y las métricas pasan a
  una columna.

---

## Lo que no hace

Sin multijugador ni fantasmas de otros ciclistas. Sin entrenamientos
estructurados por bloques (el modo ERG es manual). Sin sincronización
automática con Strava — se exporta TCX y se sube a mano. Sin vista 3D: el mapa
es 2D y el perfil es un gráfico. Nada de eso está a medias; simplemente no
está.

---

MIT.
