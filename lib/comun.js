// Utilidades compartidas por las funciones del servidor (functions/…).
// No contiene ningún secreto: los secretos llegan por las variables de Cloudflare (env).

export const MAX_DISPOSITIVOS = 2;
export const COOKIE_SESION = 'od_sess';
export const COOKIE_ACCESO = 'od_acc';
export const UN_ANO = 60 * 60 * 24 * 365;
export const DIAS_ACCESO = 30;          // el permiso para descargar barajas de pago caduca y se renueva solo

// Código de producto de Payhip (lo que va tras payhip.com/b/) de cada oráculo. Es el que devuelve
// Payhip como "product_link" al verificar una licencia. Al añadir un oráculo nuevo de pago hay que
// añadirlo aquí y en BARAJAS_PAGO (más abajo).
export const PRODUCTO_PAYHIP = {
  'atman': 'duJaS',
  'rumi': ['lXgpS', 'Kva0t', '0HTUA'],   // Meditación, Éxtasis, Nirvana
  'guru': ['hzDlq', '3Z8DG', 's5ryQ'],   // Meditación, Éxtasis, Nirvana
  'dioses-india': ['MOAE9', 'qpt7U', 'TdGkw'],   // Meditación, Éxtasis, Nirvana
  'anandamayi-ma': ['xrboc', '0ADIi', 'XhPLA'],   // Meditación, Éxtasis, Nirvana
  // Una baraja puede venderse en varios niveles: cada uno es un producto distinto de Payhip y todos
  // abren la misma baraja. Ramana Maharshi: Meditación (Z1mgj), Éxtasis (VFl5Y) y Nirvana (0XFry).
  'ramana-maharshi': ['Z1mgj', 'VFl5Y', '0XFry'],
  'ecos-egipto': ['bytxq', 'joh2R', '2IiBW'],   // Meditación, Éxtasis, Nirvana
};

// Barajas de pago y sus 2 cartas de muestra (públicas en la página de muestra).
export const BARAJAS_PAGO = {
  'rumi': ['01', '27'],
  'guru': ['buda', 'ramana-maharshi'],
  'dioses-india': ['ganesha', 'lakshmi'],
  'anandamayi-ma': ['01', '17'],
  'ramana-maharshi': ['01', '32'],
  'ecos-egipto': ['01', '22'],
};

/* ---------- respuestas ---------- */
export function json(status, body, cookies) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const c of cookies || []) if (c) h.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers: h });
}

/* ---------- Upstash Redis ---------- */
export const hayUpstash = env => !!(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
export async function kv(env, comando) {
  const r = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) throw new Error('Upstash ' + comando[0] + ' (' + r.status + ')');
  return d.result;
}
export async function kvGet(env, clave) {
  const v = await kv(env, ['GET', clave]);
  if (v == null) return null;
  try { return JSON.parse(v); } catch (e) { return v; }
}
export const kvSet = (env, clave, valor, segundos) =>
  kv(env, segundos ? ['SET', clave, JSON.stringify(valor), 'EX', String(segundos)] : ['SET', clave, JSON.stringify(valor)]);

// Límite de peticiones por IP (ventana fija). Si Upstash falla no bloquea: las funciones que
// dependen de Upstash ya fallan en cerrado por su cuenta.
export async function dentroDelLimite(env, request, ambito, maximo, segundos) {
  if (!hayUpstash(env)) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'sin-ip';
  const clave = 'od:rl:' + ambito + ':' + ip + ':' + Math.floor(Date.now() / 1000 / segundos);
  try {
    const n = await kv(env, ['INCR', clave]);
    if (n === 1) await kv(env, ['EXPIRE', clave, String(segundos + 5)]);
    return n <= maximo;
  } catch (e) { return true; }
}

/* ---------- cookies ---------- */
export function leerCookie(request, nombre) {
  for (const p of (request.headers.get('Cookie') || '').split(';')) {
    const t = p.trim(); if (t.startsWith(nombre + '=')) return t.slice(nombre.length + 1);
  }
  return null;
}
export const cookieSesion = token => COOKIE_SESION + '=' + token + '; Max-Age=' + UN_ANO + '; Path=/; HttpOnly; Secure; SameSite=Lax';
export function nuevoToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

/* ---------- base64url ---------- */
const enc = new TextEncoder();
export function b64url(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

/* ---------- firma de la colección (la comprueba la app con la clave pública) ---------- */
export async function firmar(env, oraculo, licencia, dispositivo) {
  const clave = await crypto.subtle.importKey('jwk', JSON.parse(env.OD_CLAVE_FIRMA), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const datos = enc.encode('od1|' + oraculo + '|' + licencia + '|' + dispositivo);
  return b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, clave, datos));
}

/* ---------- permiso de acceso a los archivos de pago (cookie od_acc, HttpOnly) ----------
   Lo emite el servidor tras comprobar la licencia (activar) o la sesión (sesion). Lo comprueba
   functions/oraculos/[[path]].js antes de entregar cada carta, audio o texto de pago.
   Firmado con HMAC-SHA256; la clave se deriva de OD_CLAVE_FIRMA (no hace falta otra variable). */
let claveHmac = null, claveHmacDe = null;
async function hmac(env) {
  if (claveHmac && claveHmacDe === env.OD_CLAVE_FIRMA) return claveHmac;
  const h = await crypto.subtle.digest('SHA-256', enc.encode('od-acceso|' + env.OD_CLAVE_FIRMA));
  claveHmac = await crypto.subtle.importKey('raw', h, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  claveHmacDe = env.OD_CLAVE_FIRMA;
  return claveHmac;
}
export async function cookiePermiso(env, dispositivo, oraculos) {
  if (!oraculos.length) return { cookie: COOKIE_ACCESO + '=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax', hasta: 0 };
  const hasta = Date.now() + DIAS_ACCESO * 864e5;
  const datos = b64url(enc.encode(JSON.stringify({ d: dispositivo, o: oraculos, e: hasta })));
  const firma = b64url(await crypto.subtle.sign('HMAC', await hmac(env), enc.encode(datos)));
  return { cookie: COOKIE_ACCESO + '=' + datos + '.' + firma + '; Max-Age=' + DIAS_ACCESO * 86400 + '; Path=/; HttpOnly; Secure; SameSite=Lax', hasta };
}
export async function leerPermiso(request, env) {
  const v = leerCookie(request, COOKIE_ACCESO);
  if (!v || !env.OD_CLAVE_FIRMA) return null;
  const [datos, firma] = v.split('.');
  if (!datos || !firma) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmac(env), deB64url(firma), enc.encode(datos));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(deB64url(datos)));
    if (!p || !Array.isArray(p.o) || !(p.e > Date.now())) return null;
    return p;
  } catch (e) { return null; }
}

/* ---------- Payhip ---------- */
export function productos(env) {
  return Object.keys(env)
    .filter(k => k.startsWith('PAYHIP_SECRET_') && env[k])
    .map(k => ({ id: k.slice('PAYHIP_SECRET_'.length).toLowerCase().replace(/_/g, '-'), secreto: env[k] }));
}
// Códigos de Payhip: se comparan sin distinguir mayúsculas y confundiendo i/l/1 y o/0, que se parecen
// mucho al copiarlos de una captura. También vale que Payhip devuelva la dirección completa del producto.
const plegar = c => (String(c || '').trim().toLowerCase().split(/[\/?#]/).filter(Boolean).pop() || '').replace(/[1i]/g, 'l').replace(/0/g, 'o');
function oraculoDeProducto(link) {
  const l = plegar(link);
  if (!l) return null;
  for (const id of Object.keys(PRODUCTO_PAYHIP)) {
    const codigos = [].concat(PRODUCTO_PAYHIP[id]);       // un código o una lista de códigos
    if (codigos.some(c => plegar(c) === l)) return id;
  }
  return null;
}

// Pregunta a Payhip de qué producto es la licencia. El oráculo se decide por el producto que dice
// Payhip (product_link), nunca por la clave con la que se preguntó.
// Devuelve { oraculo, enabled, email } | { producto } (licencia válida de un producto no registrado)
//        | null (no existe) ; lanza un error si Payhip no responde (para no revocar por un fallo).
async function preguntarPayhip(env, licencia) {
  let desconocido = null, respondio = false;
  for (const { secreto } of productos(env)) {
    let r;
    try {
      r = await fetch('https://payhip.com/api/v2/license/verify?license_key=' + encodeURIComponent(licencia), {
        headers: { 'product-secret-key': secreto },
      });
    } catch (e) { continue; }
    if (r.status >= 500 || r.status === 429) continue;
    respondio = true;
    const texto = await r.text();
    if (!texto) continue;                         // no es de este producto
    let datos = null; try { datos = JSON.parse(texto).data; } catch (e) {}
    if (!datos) continue;
    const oraculo = oraculoDeProducto(datos.product_link);
    if (oraculo) return { oraculo, enabled: datos.enabled !== false, email: String(datos.buyer_email || '').trim().toLowerCase() };
    desconocido = { producto: String(datos.product_link || '') };
  }
  if (!respondio) throw new Error('Payhip no responde');
  return desconocido;
}

// Igual, pero recordando la respuesta un rato en Upstash (menos llamadas a Payhip, más rápido,
// y un ataque no puede hacer que Payhip bloquee las claves de la tienda).
export async function consultarPayhip(env, licencia, maxEdadSeg) {
  const clave = 'od:pay:' + licencia;
  if (hayUpstash(env)) {
    try {
      const c = await kvGet(env, clave);
      if (c && c.t && Date.now() - c.t < maxEdadSeg * 1000) return c.r;
    } catch (e) {}
  }
  const r = await preguntarPayhip(env, licencia);
  if (hayUpstash(env)) {
    try { await kvSet(env, clave, { t: Date.now(), r }, r ? 6 * 3600 : 120); } catch (e) {}
  }
  return r;
}
