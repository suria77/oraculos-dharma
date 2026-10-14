/* Uso sin conexión de Oráculos del Dharma (ver sw.js y offline-files.js). Basado en Japa-Móvil.
   - Guarda la interfaz en segundo plano poco después de abrir la app con conexión.
   - Guarda solas las cartas de cada oráculo al abrirlo.
   - Ofrece a la página (window.ODOffline) descargar los audios de un oráculo, con progreso.
   - Muestra un aviso cuando se pierde y se recupera la conexión. */
(function () {
  'use strict';
  var CFG = window.OD_OFFLINE;
  var hayCache = !!CFG && ('caches' in window);
  var NAMES = (CFG && CFG.caches) || { shell: 'od-shell-v1', assets: 'od-assets-v1', media: 'od-media-v1' };
  function abs(rel) { return new URL(rel, document.baseURI).href; }

  /* ---------- Aviso de conexión ---------- */
  var css = document.createElement('style');
  css.textContent =
    '.od-off-pill{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);transform:translate(-50%,24px);' +
    'z-index:1300;max-width:calc(100% - 32px);padding:12px 20px;border-radius:999px;background:#fbf7ff;color:#2c0f4e;' +
    'border:2px solid #a64dff;box-shadow:0 8px 26px rgba(0,0,0,.45);font:700 15px/1.3 Montserrat,Arial,sans-serif;text-align:center;' +
    'opacity:0;pointer-events:none;transition:opacity .25s ease,transform .25s ease}' +
    '.od-off-pill.od-on{opacity:1;transform:translate(-50%,0)}';
  document.head.appendChild(css);
  var pill = document.createElement('div');
  pill.className = 'od-off-pill';
  pill.setAttribute('role', 'status');
  var pillT = null;
  function aviso(texto, ms) {
    if (!pill.parentNode) document.body.appendChild(pill);
    pill.textContent = texto; pill.classList.add('od-on');
    clearTimeout(pillT);
    if (ms) pillT = setTimeout(function () { pill.classList.remove('od-on'); }, ms);
  }
  var estabaSinRed = false;
  function alCambiarRed() {
    if (!navigator.onLine) { estabaSinRed = true; aviso('Sin conexión. Tus oráculos guardados siguen funcionando.', 0); }
    else if (estabaSinRed) { estabaSinRed = false; aviso('Conexión recuperada.', 2200); precargarCore(); }
    else pill.classList.remove('od-on');
  }
  window.addEventListener('offline', alCambiarRed);
  window.addEventListener('online', alCambiarRed);

  if (!hayCache) { window.ODOffline = null; return; }

  /* ---------- Qué hay guardado ---------- */
  function guardados() {
    return Promise.all([NAMES.shell, NAMES.assets, NAMES.media].map(function (n) {
      return caches.open(n).then(function (c) { return c.keys(); }).then(function (rs) {
        var s = {}; rs.forEach(function (r) { s[r.url] = 1; }); return s;
      }).catch(function () { return {}; });
    })).then(function (sets) {
      return function (u) { var a = abs(u); return !!(sets[0][a] || sets[1][a] || sets[2][a]); };
    });
  }

  function grupo(id, tipo) {
    var o = CFG.oraculos && CFG.oraculos[id];
    if (!o) return { urls: [], sizes: [] };
    return tipo === 'audio' ? { urls: o.audio, sizes: o.audioSz } : { urls: o.images, sizes: o.imagesSz };
  }

  function estado(id) {
    return guardados().then(function (tiene) {
      var res = {};
      ['images', 'audio'].forEach(function (t) {
        var g = grupo(id, t), have = 0, faltan = [], bytes = 0;
        g.urls.forEach(function (u, i) { if (tiene(u)) have++; else { faltan.push(i); bytes += g.sizes[i] || 0; } });
        res[t] = { total: g.urls.length, have: have, faltan: faltan, bytesFaltan: bytes };
      });
      res.completo = res.images.have >= res.images.total && res.audio.have >= res.audio.total;
      res.bytesFaltan = res.images.bytesFaltan + res.audio.bytesFaltan;
      return res;
    });
  }

  function bajarYGuardar(url, cache) {
    return fetch(abs(url), { headers: { 'x-od-dl': '1' }, credentials: 'same-origin' }).then(function (r) {
      if (!r || !r.ok || r.status !== 200) throw new Error('http');
      return caches.open(cache).then(function (c) { return c.put(abs(url), r); });
    });
  }

  function cola(items, paralelo, alTerminarUno, debeParar) {
    var pos = 0, activos = 0, fallos = 0, sinEspacio = false;
    return new Promise(function (resolve) {
      function sig() {
        if (debeParar() || sinEspacio || pos >= items.length) { if (activos === 0) resolve({ fallos: fallos, sinEspacio: sinEspacio }); return; }
        var it = items[pos++]; activos++;
        function intento(n) {
          return bajarYGuardar(it.url, it.cache).catch(function (err) {
            if (err && err.name === 'QuotaExceededError') { sinEspacio = true; throw err; }
            if (n < 1 && navigator.onLine) return intento(n + 1);
            throw err;
          });
        }
        intento(0).catch(function () { fallos++; }).then(function () { activos--; alTerminarUno(it); sig(); });
      }
      if (!items.length) resolve({ fallos: 0, sinEspacio: false });
      for (var i = 0; i < paralelo; i++) sig();
    });
  }

  /* Interfaz: se guarda sola, sin avisos */
  var coreEnMarcha = false;
  function precargarCore() {
    if (coreEnMarcha || !navigator.onLine || !CFG.core) return;
    if (navigator.connection && navigator.connection.saveData) return;
    coreEnMarcha = true;
    guardados().then(function (tiene) {
      var items = CFG.core.filter(function (u) { return !tiene(u); }).map(function (u) { return { url: u, cache: NAMES.shell }; });
      return cola(items, 3, function () {}, function () { return false; });
    }).catch(function () {}).then(function () { coreEnMarcha = false; });
  }

  /* Cartas de un oráculo: se guardan solas al abrirlo */
  var cartasEnMarcha = {};
  function guardarCartas(id) {
    if (cartasEnMarcha[id] || !navigator.onLine) return;
    cartasEnMarcha[id] = true;
    estado(id).then(function (st) {
      var g = grupo(id, 'images');
      var items = st.images.faltan.map(function (i) { return { url: g.urls[i], cache: NAMES.assets }; });
      return cola(items, 3, function () {}, function () { return false; });
    }).catch(function () {}).then(function () { delete cartasEnMarcha[id]; });
  }

  /* Descarga completa (cartas + audios) de un oráculo, con progreso */
  var trabajo = null;
  function descargar(id, alProgreso) {
    if (trabajo && trabajo.enMarcha) return Promise.resolve({ ocupado: true });
    if (!navigator.onLine) return Promise.resolve({ sinRed: true });
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    return estado(id).then(function (st) {
      var items = [], total = 0;
      ['images', 'audio'].forEach(function (t) {
        var g = grupo(id, t);
        st[t].faltan.forEach(function (i) {
          items.push({ url: g.urls[i], cache: t === 'audio' ? NAMES.media : NAMES.assets, bytes: g.sizes[i] || 0 });
          total += g.sizes[i] || 0;
        });
      });
      trabajo = { enMarcha: true, parar: false, total: total || 1, hecho: 0 };
      return cola(items, 3, function (it) {
        trabajo.hecho += it.bytes;
        if (alProgreso) alProgreso(Math.min(100, Math.round(100 * trabajo.hecho / trabajo.total)));
      }, function () { return trabajo.parar; }).then(function (r) {
        var parado = trabajo.parar;
        trabajo.enMarcha = false;
        return { fallos: r.fallos, sinEspacio: r.sinEspacio, parado: parado };
      });
    });
  }
  function parar() { if (trabajo) trabajo.parar = true; }

  window.ODOffline = { estado: estado, descargar: descargar, parar: parar, guardarCartas: guardarCartas };

  function init() {
    if (!navigator.onLine) alCambiarRed();
    setTimeout(precargarCore, 4000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
