/* Service Worker de Oráculos del Dharma.
   La app se abre aunque la red falle o esté bloqueada:
   - La página se pide primero a la red (con un tiempo máximo) para que las actualizaciones lleguen
     al momento; si no hay red, se sirve la guardada. Si no hay nada guardado, una página «sin conexión».
   - Manifiesto, iconos, tipografías e imágenes de la interfaz: guardados y refrescados en segundo plano.
   - Cartas (imágenes y textos) de cada oráculo: se guardan al usarlas y no se vuelven a pedir.
     Cada archivo se descarga UNA sola vez aunque lo pidan a la vez la pantalla y «Guardar sin conexión».
   - Audios: se descargan enteros una sola vez, se guardan y se reproducen desde lo guardado (con
     soporte de "Range", que es lo que usa el reproductor).
   - Si una carta o un audio cambia de contenido (mismo nombre), se borra la copia vieja al actualizar
     (offline-files.js lleva una huella de cada archivo).
   - /api/* (licencias) y los vídeos nunca se guardan.
   La lista de archivos sale de offline-files.js (lo genera tools/make-offline-list.py). */
try { importScripts('offline-files.js'); } catch (e) {}
var CFG = self.OD_OFFLINE || {};
var CN = CFG.caches || { shell: 'od-shell-v1', assets: 'od-assets-v1', media: 'od-media-v1' };
var SHELL = CN.shell, ASSETS = CN.assets, MEDIA = CN.media, META = 'od-meta';
var SCOPE = self.registration.scope;
var MAX_AUDIO = 60 * 1024 * 1024;
var ESPERA_RED_MS = 1800;

var PRECACHE = [SCOPE, SCOPE + 'manifest.webmanifest', SCOPE + 'offline.js', SCOPE + 'offline-files.js',
                SCOPE + 'img/icon.png', SCOPE + 'img/cabecera-poster.jpg', SCOPE + 'img/logo-dharma.png',
                SCOPE + 'fonts/montserrat.woff', SCOPE + 'fonts/cormorant.woff'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    /* Uno a uno: si falta alguno, no se cancela la instalación */
    return Promise.all(PRECACHE.map(function (u) {
      return fetch(u, { cache: 'no-cache' }).then(function (r) {
        if (r && r.ok && !r.redirected) return c.put(u, r);
      }).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

/* Borra las copias guardadas de cartas y audios cuyo contenido ha cambiado (según la huella) */
function limpiarCambiados() {
  var nuevas = CFG.huellas || {};
  return caches.open(META).then(function (meta) {
    return meta.match('huellas').then(function (r) { return r ? r.json() : null; }).catch(function () { return null; })
      .then(function (viejas) {
        var cambiados = [];
        if (viejas) Object.keys(nuevas).forEach(function (k) { if (viejas[k] && viejas[k] !== nuevas[k]) cambiados.push(SCOPE + k); });
        return Promise.all([ASSETS, MEDIA].map(function (n) {
          return caches.open(n).then(function (c) { return Promise.all(cambiados.map(function (u) { return c.delete(u); })); });
        })).then(function () {
          return meta.put('huellas', new Response(JSON.stringify(nuevas), { headers: { 'Content-Type': 'application/json' } }));
        });
      });
  }).catch(function () {});
}

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) {
      /* Solo se borran versiones antiguas; cartas y audios se conservan */
      if (k.indexOf('od-shell-') === 0 && k !== SHELL) return caches.delete(k);
      if (k.indexOf('od-media-') === 0 && k !== MEDIA) return caches.delete(k);
      if (k.indexOf('od-assets-') === 0 && k !== ASSETS) return caches.delete(k);
    }));
  }).then(limpiarCambiados).then(function () { return self.clients.claim(); }));
});

function esAudio(u) { return /\.(mp3|m4a|wav|ogg|aac)$/i.test(u.pathname); }
function esVideo(u) { return /\.(mp4|webm|mov|m4v)$/i.test(u.pathname); }
function esCarta(u) { return u.pathname.indexOf('/oraculos/') !== -1; }

/* Una sola descarga por archivo aunque lo pidan varios a la vez; se guarda y se devuelve */
var enVuelo = {};
function traerYGuardar(url, destino, limite) {
  if (!enVuelo[url]) {
    enVuelo[url] = fetch(url, { credentials: 'same-origin' }).then(function (r) {
      var len = parseInt(r.headers.get('content-length') || '0', 10);
      if (r && r.ok && r.status === 200 && !(limite && len > limite)) {
        return caches.open(destino).then(function (c) { return c.put(url, r.clone()); })
          .catch(function () {}).then(function () { return r; });
      }
      return r;
    });
    enVuelo[url].then(function () { delete enVuelo[url]; }, function () { delete enVuelo[url]; });
  }
  return enVuelo[url].then(function (r) { return r.clone(); });
}

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

/* Audio: si está guardado, desde ahí; si no, se descarga entero UNA vez, se guarda y se sirve */
function respuestaAudio(event) {
  var req = event.request, url = req.url.split('#')[0];
  return caches.match(url).then(function (hit) {
    if (hit) return rangoDesdeCache(req, hit);
    return traerYGuardar(url, MEDIA, MAX_AUDIO).then(function (r) {
      if (r && r.ok && r.status === 200) return rangoDesdeCache(req, r);
      return r;
    }).catch(function () { return fetch(req); });
  });
}

/* Caché primero y se refresca en segundo plano */
function cacheYRefresco(event, clave, destino) {
  return caches.match(clave).then(function (hit) {
    var red = fetch(event.request).then(function (r) {
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

/* Página: red primero (con tiempo máximo) para que las actualizaciones lleguen enseguida */
var PAGINA_SIN_RED = '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Sin conexión · Oráculos del Dharma</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#150317;color:#fbf7ff;font:17px/1.6 Georgia,serif;text-align:center;padding:24px;box-sizing:border-box">' +
  '<div><h1 style="color:#f4d47c;font-weight:600">Oráculos del Dharma</h1><p>Ahora mismo no hay conexión y la app todavía no está guardada en este dispositivo.</p>' +
  '<p>Conéctate a internet y vuelve a abrirla: a partir de entonces funcionará también sin conexión.</p>' +
  '<p><button onclick="location.reload()" style="font:700 16px Arial,sans-serif;padding:12px 24px;border-radius:999px;border:0;background:#f4d47c;color:#2c0f4e">Reintentar</button></p></div></body></html>';
function respuestaPagina(event) {
  var red = fetch(event.request).then(function (r) {
    if (r && r.ok && !r.redirected) { var copia = r.clone(); caches.open(SHELL).then(function (c) { c.put(SCOPE, copia); }); }
    return r;
  });
  var tope = new Promise(function (res) { setTimeout(function () { res(null); }, ESPERA_RED_MS); });
  return Promise.race([red.catch(function () { return null; }), tope]).then(function (r) {
    if (r && r.ok) return r;
    return caches.match(SCOPE).then(function (hit) {
      if (hit) { event.waitUntil(red.catch(function () {})); return hit; }
      return red.catch(function () {
        return new Response(PAGINA_SIN_RED, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;   /* licencias: siempre por red */
  if (req.url.indexOf(SCOPE) !== 0) return;
  if (esVideo(url)) return;                          /* vídeos: siempre por red */
  if (url.searchParams.has('directo')) return;       /* audios de la página de muestra: siempre directos */

  if (esAudio(url)) { event.respondWith(respuestaAudio(event)); return; }
  if (req.mode === 'navigate') { event.respondWith(respuestaPagina(event)); return; }
  if (req.headers.has('range')) return;
  if (esCarta(url)) {
    var u = req.url.split('#')[0];
    event.respondWith(caches.match(u).then(function (hit) { return hit || traerYGuardar(u, ASSETS); }));
    return;
  }
  event.respondWith(cacheYRefresco(event, req.url, SHELL));
});
