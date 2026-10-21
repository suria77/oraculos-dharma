/* Service Worker de Oráculos del Dharma (basado en el de Japa-Móvil).
   La app se abre aunque la red falle o esté bloqueada:
   - La página, el manifiesto, los iconos y las tipografías se guardan en el móvil y se
     sirven desde ahí al instante; se actualizan en segundo plano cuando hay conexión.
   - Las cartas (imágenes) de cada oráculo se guardan al usarlas (caché permanente).
   - Los audios se guardan al escucharlos o todos de golpe con "Guardar sin conexión"
     (ver offline.js), y se sirven con soporte de "Range" para que el reproductor funcione.
   - /api/* (licencias) y los vídeos nunca se guardan: sin red se ve la imagen fija.
   La lista de archivos sale de offline-files.js (lo genera tools/make-offline-list.py).
   Para obligar a todos los móviles a bajar la interfaz de nuevo, sube VERSION allí. */
try { importScripts('offline-files.js'); } catch (e) {}
var CFG = self.OD_OFFLINE || {};
var CN = CFG.caches || { shell: 'od-shell-v1', assets: 'od-assets-v1', media: 'od-media-v1' };
var SHELL = CN.shell, ASSETS = CN.assets, MEDIA = CN.media;
var SCOPE = self.registration.scope;
var MAX_AUDIO = 60 * 1024 * 1024;

var PRECACHE = [SCOPE, SCOPE + 'manifest.webmanifest', SCOPE + 'offline.js', SCOPE + 'offline-files.js',
                SCOPE + 'img/icon.png', SCOPE + 'img/cabecera-poster.jpg', SCOPE + 'img/logo-dharma.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    /* Uno a uno: si falta alguno, no se cancela la instalación */
    return Promise.all(PRECACHE.map(function (u) {
      return fetch(u, { cache: 'reload' }).then(function (r) {
        if (r && r.ok && !r.redirected) return c.put(u, r);
      }).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      /* Solo se borran versiones antiguas de la interfaz; cartas y audios se conservan */
      if (k.indexOf('od-shell-') === 0 && k !== SHELL) return caches.delete(k);
      /* Si cambian los audios (p. ej. volumen igualado), se sube la versión de media y se borran los viejos */
      if (k.indexOf('od-media-') === 0 && k !== MEDIA) return caches.delete(k);
      if (k.indexOf('od-assets-') === 0 && k !== ASSETS) return caches.delete(k);
    }));
  }).then(function () { return self.clients.claim(); }));
});

function esAudio(u) { return /\.(mp3|m4a|wav|ogg|aac)$/i.test(u.pathname); }
function esVideo(u) { return /\.(mp4|webm|mov|m4v)$/i.test(u.pathname); }
function esFuente(u) { return u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com'; }
function esCarta(u) { return u.pathname.indexOf('/oraculos/') !== -1; }

/* Responde a una petición con Range (los <audio> la usan) a partir del archivo completo guardado */
function rangoDesdeCache(request, completo) {
  var h = request.headers.get('range');
  var m = h && /bytes=(\d*)-(\d*)/.exec(h);
  if (!m) return Promise.resolve(completo);
  return completo.arrayBuffer().then(function (buf) {
    var size = buf.byteLength;
    var ini = m[1] === '' ? Math.max(0, size - parseInt(m[2], 10)) : parseInt(m[1], 10);
    var fin = (m[1] === '' || m[2] === '') ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    if (isNaN(ini) || ini >= size || fin < ini) {
      return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
    }
    return new Response(buf.slice(ini, fin + 1), {
      status: 206,
      headers: {
        'Content-Type': completo.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Length': String(fin - ini + 1),
        'Content-Range': 'bytes ' + ini + '-' + fin + '/' + size,
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

var pendientes = {};
function guardarAudioEnSegundoPlano(url) {
  if (pendientes[url]) return;
  pendientes[url] = true;
  fetch(url, { headers: { 'x-od-dl': '1' } }).then(function (r) {
    var len = parseInt(r.headers.get('content-length') || '0', 10);
    if (!r.ok || r.status !== 200 || (len && len > MAX_AUDIO)) return;
    return caches.open(MEDIA).then(function (c) { return c.put(url, r); });
  }).catch(function () {}).then(function () { delete pendientes[url]; });
}

function respuestaAudio(event) {
  var req = event.request;
  return caches.match(req.url).then(function (hit) {
    if (hit) return rangoDesdeCache(req, hit);
    guardarAudioEnSegundoPlano(req.url);
    return fetch(req);
  });
}

/* Caché primero y se refresca en segundo plano */
function cacheYRefresco(event, clave, destino) {
  return caches.match(clave).then(function (hit) {
    var red = fetch(clave === SCOPE ? SCOPE : event.request).then(function (r) {
      if (r && (r.ok || r.type === 'opaque') && !r.redirected) {
        var copia = r.clone();
        caches.open(destino).then(function (c) { c.put(clave, copia); });
      }
      return r;
    });
    if (hit) { event.waitUntil(red.catch(function () {})); return hit; }
    return red;
  });
}

/* Cartas: si ya está guardada no se vuelve a pedir (no cambian) */
function primeroCache(event, destino) {
  return caches.match(event.request.url).then(function (hit) {
    if (hit) return hit;
    return fetch(event.request).then(function (r) {
      if (r && r.ok && r.status === 200) {
        var copia = r.clone();
        caches.open(destino).then(function (c) { c.put(event.request.url, copia); });
      }
      return r;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (esFuente(url)) { event.respondWith(cacheYRefresco(event, req.url, SHELL)); return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;   /* licencias: siempre por red */
  if (req.url.indexOf(SCOPE) !== 0) return;
  if (req.headers.has('x-od-dl')) return;            /* descargas de "Guardar sin conexión" */
  if (esVideo(url)) return;                          /* vídeos: siempre por red */

  if (esAudio(url)) { event.respondWith(respuestaAudio(event)); return; }
  if (req.mode === 'navigate') { event.respondWith(cacheYRefresco(event, SCOPE, SHELL)); return; }
  if (req.headers.has('range')) return;
  if (esCarta(url)) { event.respondWith(primeroCache(event, ASSETS)); return; }
  event.respondWith(cacheYRefresco(event, req.url, SHELL));
});
