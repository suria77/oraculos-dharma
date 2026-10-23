# Oráculos del Dharma

App web instalable (PWA) con los oráculos de Dharma Eterno. Se aloja en Cloudflare Pages
conectado a este repositorio.

## Variables en Cloudflare (Settings → Variables and Secrets)

| Nombre | Qué es |
|---|---|
| `PAYHIP_SECRET_ATMAN`, `PAYHIP_SECRET_RUMI`, `PAYHIP_SECRET_GURU`, `PAYHIP_SECRET_DIOSES_INDIA` | Product secret key de cada oráculo en Payhip. Lo que va detrás de `PAYHIP_SECRET_` es el `id` del oráculo en `index.html` (los guiones se escriben como `_`). |
| `OD_CLAVE_FIRMA` | Clave privada para firmar las licencias (tipo *Secret*). Nunca se sube al repositorio. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Las mismas de Japa-Móvil (límite de 2 dispositivos y sesión de respaldo). |

## Cómo se protege la colección

1. **Puerta en el servidor** (`functions/oraculos/[[path]].js`): las cartas, audios y textos (`cartas.json`) de las barajas de pago solo se entregan con un **permiso de acceso** (cookie `od_acc`, HttpOnly, firmada, caduca a los 30 días y se renueva sola). Sin él, el servidor responde 401. Lo de la página de muestra (portada, fondo, dorso, miniaturas y las 2 cartas de muestra) es público.
2. **Payhip**: licencia activa y correo del comprador (respuesta recordada unos minutos en Upstash).
3. **2 dispositivos por licencia**, con opción de liberar el más antiguo **una vez cada 30 días**.
4. **Falla en cerrado**: si Upstash no responde, no se activa nada (el límite nunca se salta).
5. **Límite de peticiones** por IP en `/api/*`.
6. **Firma digital** de cada oráculo ligada al dispositivo (la comprueba la app).
7. **Sesión de respaldo** en el servidor (cookie `od_sess`, HttpOnly, 1 año): recupera la colección, renueva el permiso y quita lo reembolsado o liberado.
8. **Cabeceras de seguridad** en `_headers` (CSP, anti-incrustación…).

Si se añade una baraja de pago nueva: añadir su código de Payhip en `PRODUCTO_PAYHIP` y sus 2 cartas de muestra en `BARAJAS_PAGO` (`lib/comun.js`), su ruta en `_routes.json`, y sacar sus textos a `oraculos/<id>/cartas.json` (en `index.html` solo van título e imagen).

**Anandamayi Ma (provisional, en pruebas):** arriba sale como MUESTRA y en «Tu colección» está ABIERTA (`pruebaEnColeccion: true`). Sus archivos aún son públicos. Para cerrarla: poner su enlace en `payhip` (index.html), quitar `pruebaEnColeccion`, añadir `'anandamayi-ma'` a `PRODUCTO_PAYHIP` y `BARAJAS_PAGO` (muestras `['01', '17']`) en `lib/comun.js`, añadir `/oraculos/anandamayi-ma/*` a `_routes.json` y crear la variable `PAYHIP_SECRET_ANANDAMAYI_MA` en Cloudflare.

Diagnóstico: `/api/estado` solo dice si está listo. Para ver el detalle, añade la variable `ESTADO_CLAVE` en Cloudflare y abre `/api/estado?clave=<esa palabra>`.

Herramienta de pruebas («Quitar de este dispositivo», 5 toques en «Tu colección»): aparece sola en los dispositivos donde se ha activado una licencia con el correo del dueño (también con `?pruebas=1`).

## Uso sin conexión

`sw.js` guarda la interfaz y las cartas; los audios se guardan al escucharlos o con el botón
«Guardar sin conexión» de cada oráculo. El vídeo de cabecera va por red (sin conexión se ve la imagen fija).

**Siempre que se añadan, quiten o renombren imágenes, audios u oráculos**, hay que regenerar la lista:

```
python3 tools/make-offline-list.py
```

Para obligar a todos los móviles a bajar la interfaz nueva, sube `VERSION` en ese script.
