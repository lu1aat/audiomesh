# audiomesh

*[Read in English](./README.md)*

**[▶ Abrir la app](https://lu1aat.github.io/audiomesh/)**: corre en el
navegador, no hay que instalar nada.

Una pequeña red acústica que funciona entera en el navegador y usa el parlante y el
micrófono como radio. Las estaciones intercambian mensajes de chat, anuncios,
pruebas de enlace y repeticiones por sonido: audible, de baja frecuencia o
ultrasónico (17,5–21 kHz, inaudible para la mayoría de las personas).

Toma las técnicas de señal débil de los modos digitales de radioaficionados como FT8
y JS8: modulación 8-GFSK, secuencias de sincronismo Costas, corrección de errores
LDPC(174,91) y ranuras de tiempo alineadas a UTC. El modo por defecto decodifica
tramas hasta unos −18 dB de SNR en 2500 Hz.

Sin servidor, sin cuenta, sin subir nada. El audio se procesa en la pestaña y nunca
sale del dispositivo; una Content Security Policy bloquea toda petición de red salvo
una verificación opcional de hora contra el mismo origen.

## Características

- **Seis modos**, de rápido a profundo: T (turbo, ranuras de 2,5 s), C (rápido,
  5 s), B (medio, 10 s), A (normal, 15 s), L (largo, 30 s) y D (profundo, 60 s). Los
  modos más lentos son más sensibles, hasta unos −23 dB en el modo D; el modo T solo
  llega a unos −9 dB y está pensado para pruebas entre dispositivos cercanos. Todas
  las estaciones tienen que usar el mismo modo.
- **Tres bandas** con numeración fija de canales: baja (100–300 Hz), audible
  (300–10000 Hz) y ultrasónica (17,5–21 kHz, necesita una placa de sonido de 48 kHz).
- **Chat**: mensajes generales y dirigidos de hasta 142 caracteres; los dirigidos se
  confirman y se retransmiten. Los apodos se anuncian por el aire.
- **Todos los canales decodificados a la vez**, con elección automática de canal al
  estilo ALE según la calidad de enlace medida en ambos sentidos, evitando canales
  congestionados.
- **Modo repetidor**: cualquier estación puede retransmitir tramas un salto para
  estaciones que no se escuchan entre sí.
- **Vista de red**: mapa de estaciones, señal por canal, cascada (waterfall),
  registro de tramas y herramientas de sincronización de reloj (las ranuras están
  alineadas a UTC, así que los relojes tienen que coincidir en unos ±2 s).

La especificación completa del protocolo por aire (modulación, FEC, plan de bandas,
temporización, formato de tramas, repetidor y elección de canal) está en
[`network-protocol.md`](./network-protocol.md) (en inglés).

## Uso

Abrí la app en dos dispositivos que se escuchen entre sí, elegí el mismo modo y la
misma banda en ambos, activá **Audio** y **Allow transmit**, y mandá un mensaje.
Asegurate de que los dos relojes estén en hora (la sección Sync de la pantalla
Network ayuda).

El micrófono necesita un contexto seguro: `https://` o `localhost`.

## Desarrollo

Requiere Node.js 20 o superior.

```bash
npm install
npm run dev         # servidor de desarrollo de vite en :5173
npm run test        # vitest
npm run build       # verificación de tipos y build en dist/
```

`dist/` es un sitio estático y funciona desde cualquier hosting de archivos
estáticos. `./web.sh` lo compila y lo sirve por https en la red local con el
servidor integrado de PHP y un certificado autofirmado, para probar entre teléfonos
y computadoras.

Stack: TypeScript, Vite, Web Audio con `AudioWorklet`s y un Web Worker para
decodificar. Sin framework de UI y sin dependencias en tiempo de ejecución.

## Licencia

[MIT](./LICENSE).

Las tablas de paridad LDPC(174,91) de `src/protocol/gfsk8/ldpc-tables.ts` se generan
a partir de [ft8_lib](https://github.com/kgoba/ft8_lib) (MIT, © 2018 Karlis Goba). El
código fue diseñado por los autores de WSJT-X (Joe Taylor K1JT, Steve Franke K9AN y
Bill Somerville G4WJS) para [WSJT-X](https://wsjt.sourceforge.io/). audiomesh está
inspirado en JS8Call pero no es compatible con él a nivel de protocolo.
