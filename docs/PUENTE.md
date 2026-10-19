# El puente: cómo controlar el rodillo desde un iPad

## El problema, sin rodeos

Safari no implementa Web Bluetooth. Ni en iPad, ni en iPhone, ni en el Safari
de macOS. Y en iOS **todos** los navegadores usan WebKit por debajo, así que
instalar Chrome en el iPad no cambia nada: es Safari con otro icono.

Consecuencia directa: una aplicación web que corra en un iPad no puede abrir
una conexión Bluetooth con un rodillo. No es una limitación de RideFlow ni algo
que se arregle con permisos. No existe la API.

Las salidas reales son tres:

| Vía | Qué hace falta | Qué se consigue |
|---|---|---|
| **Puente** (esta app) | Un equipo con Bluetooth cerca de la bici | Rodillo controlado de verdad, iPad como pantalla y mando |
| **Capacitor / app nativa** | Firmar y compilar con Xcode | Bluetooth nativo en el propio iPad |
| **Simulador** | Nada | Probar rutas y perfiles sin hardware |

Este documento cubre la primera.

## Cómo funciona

```
┌──────────┐   WebSocket (WiFi)    ┌─────────────────┐   BLE / ANT+   ┌───────────┐
│  iPad    │ ────────────────────► │  Puente (node)  │ ─────────────► │ Tacx Flow │
│ RideFlow │ ◄──────────────────── │  portátil o Pi  │ ◄───────────── │           │
└──────────┘   telemetría JSON     └─────────────────┘                └───────────┘
```

El iPad manda consignas («pendiente 7,4 %») y recibe telemetría (potencia,
cadencia, pulso). El puente traduce esas consignas a páginas ANT+ FE-C o a
opcodes FTMS y mantiene viva la conexión con el rodillo.

El reparto de trabajo es el correcto: el iPad hace lo que mejor hace —pantalla
grande, táctil, batería— y el Bluetooth lo pone un equipo que sí lo tiene
accesible desde el navegador o desde Node.

## Puesta en marcha

En el equipo que esté al lado de la bici:

```bash
node tools/bridge-server.mjs --backend sim
```

Eso levanta el puente con un rodillo simulado, que sirve para comprobar que el
iPad llega antes de pelearse con el Bluetooth. Para el rodillo de verdad:

```bash
npm install @abandonware/noble
node tools/bridge-server.mjs --backend ble
```

En Linux, `noble` necesita permisos de red cruda:

```bash
sudo setcap cap_net_raw+eip $(which node)
```

Después, en el iPad: **Ajustes → Rodillo → Puente en red local**, y poner
`ws://<ip-del-equipo>:8787`. La IP la imprime el propio puente al arrancar.
Para no tener que acordarse de la IP, dale al equipo un nombre mDNS (en una
Raspberry Pi con Avahi sale gratis) y usá `ws://rideflow.local:8787`.

Comprobación rápida desde el iPad: abrí `http://<ip>:8787` en Safari. Si el
puente está vivo, responde con un JSON diciendo qué backend tiene y si hay
rodillo conectado.

## El protocolo

JSON plano sobre WebSocket, sin ceremonias. Del iPad al puente:

| Mensaje | Campos | Efecto |
|---|---|---|
| `hello` | `client`, `version` | Presentación; el puente responde con `status` |
| `setSlope` | `grade` (fracción), `crr`, `cw` | Modo pendiente |
| `setTargetPower` | `watts` | Modo ERG |
| `setResistance` | `percent` (0-100) | Resistencia fija |
| `setRider` | `riderKg`, `bikeKg` | Masa para la inercia del volante |
| `disconnect` | — | Cierra la sesión |

Del puente al iPad:

| Mensaje | Campos |
|---|---|
| `status` | `connected`, `deviceName`, `supports` |
| `data` | `power`, `cadence`, `hr`, `trainerSpeed` (todos opcionales) |
| `log` | `message`, `level` |
| `error` | `message` |

Las muestras de `data` llegan parciales a propósito: el rodillo manda potencia
y cadencia, la banda manda pulso, y cada uno a su ritmo. El cliente las
fusiona en lugar de pisarse unas a otras.

## Latencia

Medida en una red doméstica normal, el camino completo
—iPad → WiFi → puente → BLE → rodillo— ronda los 60-120 ms. Para seguir un
perfil de carretera eso es irrelevante: la pendiente cambia cada varios
segundos, no cada cuadro. Donde sí se notaría es en un entrenamiento con
intervalos de arranque explosivo, y aun ahí la consigna llega antes de que el
volante haya cambiado de velocidad.

Cosas que sí arruinan la experiencia, por orden de frecuencia:

1. **WiFi de 2,4 GHz saturado.** El BLE vive en la misma banda. Si el puente
   habla WiFi en 2,4 y BLE a la vez, se pisan. Poné el puente en 5 GHz o
   conectalo por cable.
2. **El iPad durmiéndose.** RideFlow pide un *wake lock*, pero iOS sólo lo
   respeta desde la 16.4. Si tenés una versión anterior, subí el bloqueo
   automático en los ajustes del iPad.
3. **Reconexiones.** El adaptador reintenta con espera creciente hasta 15 s.
   Si el puente se cae a mitad de una serie, el rodillo se queda con la última
   consigna recibida, no se suelta.

## Si preferís la vía nativa

El código ya está preparado: `js/trainer/base.js` define el contrato y hay
cuatro adaptadores que lo cumplen. Para iPad nativo haría falta un quinto que
envuelva un plugin de Bluetooth de Capacitor. La codificación del protocolo
—que es la parte con trampa— ya está hecha y probada en
`js/trainer/protocol.js`, y vale igual para un adaptador nativo. El trabajo
restante es el andamiaje de Capacitor y la firma de la app, no el protocolo.
