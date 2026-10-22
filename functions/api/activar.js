// Cloudflare Pages Function → POST /api/activar
//
// Comprueba una licencia de Payhip, averigua de qué oráculo es y la "firma" para este
// dispositivo. Basado en el sistema de Japa-Móvil, con estas capas de seguridad:
//
//  1. Payhip: la licencia existe, está activa (si hay reembolso Payhip la desactiva) y el
//     correo coincide con el del comprador.
//  2. Máximo 2 dispositivos por licencia (con opción de liberar el más antiguo), guardado
//     en Upstash Redis.
//  3. Firma digital: el servidor firma "oráculo + licencia + dispositivo" con una clave
//     privada que solo vive aquí. La app comprueba la firma con la clave pública, así que
//     no basta con escribir a mano en la memoria del móvil para abrir un oráculo.
//  4. Sesión de respaldo: una cookie del servidor (HttpOnly, 1 año) con la lista de oráculos
//     activados en ese móvil. Si el móvil borra sus datos, la app los recupera (ver sesion.js).
//
// VARIABLES en Cloudflare → proyecto → Settings → Variables and Secrets:
//   PAYHIP_SECRET_ATMAN, PAYHIP_SECRET_RUMI…  (Product secret key de cada producto en Payhip;
//                                              lo que va detrás de PAYHIP_SECRET_ es el id del oráculo)
//   OD_CLAVE_FIRMA                             (la clave privada que te di, tipo "Secret")
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN   (las mismas de Japa-Móvil)
//
// Acciones (campo "accion" del cuerpo):
//   "activar"   → { email, licencia, dispositivo, liberar }
//   "comprobar" → { licencia, dispositivo }   (revisión semanal silenciosa)

const MAX_DISPOSITIVOS = 2;
const COOKIE = 'od_sess';
const UN_ANO = 60 * 60 * 24 * 365;

/* ---------- utilidades ---------- */
function json(status, body, cabeceras) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (cabeceras) for (const k in cabeceras) h.append(k, cabeceras[k]);
  return new Response(JSON.stringify(body), { status, headers: h });
}

async function kv(env, comando) {
  const r = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) throw new Error('Upstash ' + comando[0] + ' (' + r.status + ')');
  return d.result;
}
async function kvGet(env, clave) {
  const v = await kv(env, ['GET', clave]);
  if (v == null) return null;
  try { return JSON.parse(v); } catch (e) { return v; }
}
const kvSet = (env, clave, valor, segundos) =>
  kv(env, segundos ? ['SET', clave, JSON.stringify(valor), 'EX', String(segundos)] : ['SET', clave, JSON.stringify(valor)]);

function leerCookie(request, nombre) {
  const partes = (request.headers.get('Cookie') || '').split(';');
  for (const p of partes) { const t = p.trim(); if (t.startsWith(nombre + '=')) return t.slice(nombre.length + 1); }
  return null;
}
function nuevoToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}
function b64url(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function firmar(env, oraculo, licencia, dispositivo) {
  const jwk = JSON.parse(env.OD_CLAVE_FIRMA);
  const clave = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const datos = new TextEncoder().encode('od1|' + oraculo + '|' + licencia + '|' + dispositivo);
  return b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, clave, datos));
}

function productos(env) {
  return Object.keys(env)
    .filter((k) => k.startsWith('PAYHIP_SECRET_') && env[k])
    .map((k) => ({ id: k.slice('PAYHIP_SECRET_'.length).toLowerCase().replace(/_/g, '-'), secreto: env[k] }));   // PAYHIP_SECRET_DIOSES_INDIA → dioses-india
}

// Código de producto de Payhip (lo que va tras payhip.com/b/ en el enlace de compra) de cada oráculo.
// Es el que devuelve Payhip como "product_link" al verificar una licencia. Si se añade un oráculo
// nuevo, hay que añadir aquí su código (el mismo que lleva en "payhip:" dentro de index.html).
const PRODUCTO_PAYHIP = {
  'atman': 'duJaS',
  'rumi': 'lXgpS',
  'guru': 'hzDlq',
  'dioses-india': 'MOAE9',
};
function oraculoDeProducto(link) {
  const l = String(link || '').trim().toLowerCase();
  if (!l) return null;
  for (const id of Object.keys(PRODUCTO_PAYHIP)) if (PRODUCTO_PAYHIP[id].toLowerCase() === l) return id;
  return null;
}

// Busca la licencia en Payhip. El oráculo se decide por el producto al que Payhip dice que
// pertenece la licencia (product_link), NO por la clave con la que se ha preguntado: así una
// licencia de Rumi nunca abre otra baraja aunque Payhip responda con la clave de otro producto.
async function buscarEnPayhip(env, licencia) {
  let desconocido = null;
  for (const { secreto } of productos(env)) {
    try {
      const r = await fetch('https://payhip.com/api/v2/license/verify?license_key=' + encodeURIComponent(licencia), {
        headers: { 'product-secret-key': secreto },
      });
      const texto = await r.text();
      if (!texto) continue;                         // no es de este producto
      const datos = JSON.parse(texto).data;
      if (!datos) continue;
      const oraculo = oraculoDeProducto(datos.product_link);
      if (oraculo) return { oraculo, datos };
      desconocido = { producto: String(datos.product_link || '') };   // existe, pero no sabemos de qué baraja es
    } catch (e) { /* se prueba el siguiente */ }
  }
  return desconocido;
}

/* ---------- petición ---------- */
export async function onRequestPost({ request, env }) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch (e) { return json(400, { ok: false, error: 'Petición no válida.' }); }

  const accion = cuerpo.accion === 'comprobar' ? 'comprobar' : 'activar';
  const licencia = String(cuerpo.licencia || '').trim().toUpperCase();
  const email = String(cuerpo.email || '').trim().toLowerCase();
  const dispositivo = String(cuerpo.dispositivo || '').trim();

  if (!licencia || licencia.length > 80) return json(400, { ok: false, error: 'Escribe o pega tu licencia.' });
  if (!/^[A-Za-z0-9-]{8,64}$/.test(dispositivo)) return json(400, { ok: false, error: 'Falta el identificador del dispositivo.' });
  if (accion === 'activar' && !email) return json(400, { ok: false, error: 'Escribe el correo con el que hiciste la compra.' });
  if (!productos(env).length) return json(500, { ok: false, error: 'El sistema de licencias aún no está configurado.' });
  if (!env.OD_CLAVE_FIRMA) return json(500, { ok: false, error: 'Falta configurar la firma de licencias en el servidor (OD_CLAVE_FIRMA).' });

  const hayUpstash = !!(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);

  // 1. Payhip
  const encontrada = await buscarEnPayhip(env, licencia);
  if (!encontrada) {
    return json(200, { ok: false, error: 'No encontramos esa licencia. Revisa que esté completa, con sus guiones, tal como aparece en tu email de Payhip.' });
  }
  if (encontrada.producto !== undefined) {
    return json(200, { ok: false, error: 'La licencia es válida, pero su producto' + (encontrada.producto ? ' (código ' + encontrada.producto + ')' : '') + ' no está registrado en la app. Escríbenos y lo resolvemos enseguida.' });
  }
  const { oraculo, datos } = encontrada;
  if (datos.enabled === false) {
    return json(200, { ok: false, desactivada: true, error: 'Esta licencia está desactivada. Si crees que es un error, escríbenos.' });
  }
  if (accion === 'activar') {
    const comprador = String(datos.buyer_email || '').trim().toLowerCase();
    if (comprador && comprador !== email) {
      return json(200, { ok: false, error: 'Esa licencia no corresponde a ese correo. Usa el correo con el que hiciste la compra.' });
    }
  }

  // 2. Dispositivos
  const claveDisp = 'od:dispositivos:' + licencia;
  if (hayUpstash) {
    let lista = [];
    try { const g = await kvGet(env, claveDisp); if (Array.isArray(g)) lista = g; } catch (e) { /* si falla Upstash, no se bloquea */ }

    if (lista.indexOf(dispositivo) === -1) {
      if (accion === 'comprobar') {
        // Se liberó este dispositivo para entrar en otro: deja de valer aquí
        return json(200, { ok: false, desactivada: true, error: 'Esta licencia se está usando ahora en otros dispositivos.' });
      }
      if (lista.length >= MAX_DISPOSITIVOS) {
        if (cuerpo.liberar !== true) {
          return json(200, {
            ok: false, necesitaLiberar: true,
            error: 'Esta licencia ya está activada en ' + MAX_DISPOSITIVOS + ' dispositivos. Puedes liberar el más antiguo para activarla en este.',
          });
        }
        lista.shift();
      }
      lista.push(dispositivo);
      try { await kvSet(env, claveDisp, lista); } catch (e) {}
    }
  }

  // 3. Firma
  const firma = await firmar(env, oraculo, licencia, dispositivo);

  // 4. Sesión de respaldo (si falla, la activación vale igual)
  let cabeceras = null;
  if (hayUpstash && accion === 'activar') {
    try {
      let token = leerCookie(request, COOKIE);
      let sesion = null;
      if (token && /^[a-f0-9]{64}$/.test(token)) sesion = await kvGet(env, 'od:sesion:' + token);
      if (!sesion || sesion.dispositivo !== dispositivo) { token = nuevoToken(); sesion = { dispositivo, email, licencias: {} }; }
      sesion.licencias[oraculo] = licencia;
      sesion.email = email;
      await kvSet(env, 'od:sesion:' + token, sesion, UN_ANO);
      cabeceras = { 'Set-Cookie': COOKIE + '=' + token + '; Max-Age=' + UN_ANO + '; Path=/; HttpOnly; Secure; SameSite=Lax' };
    } catch (e) { cabeceras = null; }
  }

  return json(200, { ok: true, oraculo, licencia, firma }, cabeceras);
}

export const onRequestGet = () => json(405, { ok: false, error: 'Usa POST.' });
