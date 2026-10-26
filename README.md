# Oráculos del Dharma

App web instalable (PWA) con los oráculos de Dharma Eterno. Se aloja en Cloudflare Pages
conectado a este repositorio.

## Variables en Cloudflare (Settings → Variables and Secrets)

| Nombre | Qué es |
|---|---|
| `PAYHIP_SECRET_ATMAN`, `PAYHIP_SECRET_RUMI`, `PAYHIP_SECRET_GURU`, `PAYHIP_SECRET_DIOSES_INDIA`, `PAYHIP_SECRET_ANANDAMAYI_MA` | Product secret key de cada oráculo en Payhip. Lo que va detrás de `PAYHIP_SECRET_` es el `id` del oráculo en `index.html` (los guiones se escriben como `_`). |
| `OD_CLAVE_FIRMA` | Clave privada para firmar las licencias (tipo *Secret*). Nunca se sube al repositorio. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Las mismas de Japa-Móvil (límite de 2 dispositivos y sesión de respaldo). |

## Cómo se protege la colección

1. **Puerta en el servidor** (`functions/oraculos/[[path]].js`): las cartas, audios y textos (`cartas.json`) de las barajas de pago solo se entregan con un **permiso de acceso** (cookie `od_acc`, HttpOnly, firmada, caduca a los 30 días y se renueva sola). Sin él, el servidor responde 401. Lo de la página de muestra (portada, fondo, dorso, miniaturas, las 2 cartas de muestra y sus audios recortados al 2/3 con fundido, en `oraculos/<id>/muestra/`) es público; los audios completos, no.
2. **Payhip**: licencia activa y correo del comprador (respuesta recordada unos minutos en Upstash).
3. **2 dispositivos por licencia**, con opción de liberar el más antiguo **una vez cada 30 días**.
4. **Falla en cerrado**: si Upstash no responde, no se activa nada (el límite nunca se salta).
5. **Límite de peticiones** por IP en `/api/*`.
6. **Firma digital** de cada oráculo ligada al dispositivo (la comprueba la app).
7. **Sesión de respaldo** en el servidor (cookie `od_sess`, HttpOnly, 1 año): recupera la colección, renueva el permiso y quita lo reembolsado o liberado.
8. **Cabeceras de seguridad** en `_headers` (CSP, anti-incrustación…).

**Barajas con varios niveles de venta** (p. ej. Ramana Maharshi: Meditación, Éxtasis y Nirvana). Cada nivel es un producto distinto en Payhip y todos abren la misma baraja:
1. En `lib/comun.js`, en `PRODUCTO_PAYHIP`, la baraja lleva una lista de códigos en vez de uno solo (`'ramana-maharshi': ['Z1mgj', 'VFl5Y', '0XFry']`).
2. En Cloudflare se añade **una variable `PAYHIP_SECRET_…` por cada producto nuevo** (la clave secreta de ese producto; lo que va detrás del prefijo es libre, p. ej. `PAYHIP_SECRET_RAMANA_EXTASIS`). Sin ella, esa licencia no se puede comprobar.
3. En `index.html`, la baraja lleva `opciones: [...]` (nombre, precio, enlace de Payhip, qué incluye; `destacada: true` marca el nivel que sale elegido). La página de muestra pinta el selector y un único botón de compra.

Si se añade una baraja de pago nueva: añadir su código de Payhip en `PRODUCTO_PAYHIP` y sus 2 cartas de muestra en `BARAJAS_PAGO` (`lib/comun.js`), su ruta en `_routes.json`, y sacar sus textos a `oraculos/<id>/cartas.json` (en `index.html` solo van título e imagen).

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
