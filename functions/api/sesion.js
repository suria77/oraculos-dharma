// Cloudflare Pages Function → GET /api/sesion
//
// Último respaldo: si el móvil ha perdido su colección (iOS a veces borra los datos de las
// webs), la app pregunta aquí. Con la cookie del servidor (od_sess, HttpOnly) que creó
// activar.js se devuelven los oráculos activados en este móvil, firmados de nuevo.
// Solo se devuelven las licencias en las que este dispositivo sigue siendo uno de los 2
// permitidos. Usa las mismas variables que activar.js.
//
// POST /api/sesion  { accion: 'olvidar', oraculos: ['rumi', …] }
//   Quita esos oráculos de la sesión de respaldo de ESTE móvil (la app lo usa en
//   «Quitar de este dispositivo», para pruebas). Solo toca la sesión del propio móvil (su cookie)
//   y NO libera la plaza del dispositivo en la licencia: así no se puede usar para saltarse el
//   límite de 2 dispositivos, y volver a activar en este mismo móvil no gasta plaza.

const COOKIE = 'od_sess';
const UN_ANO = 60 * 60 * 24 * 365;

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
async function kv(env, comando) {
  const r = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || d.error) throw new Error('Upstash');
  return d.result;
}
async function kvGet(env, clave) {
  const v = await kv(env, ['GET', clave]);
  if (v == null) return null;
  try { return JSON.parse(v); } catch (e) { return v; }
}
const kvSet = (env, clave, valor, segundos) => kv(env, ['SET', clave, JSON.stringify(valor), 'EX', String(segundos)]);
function leerCookie(request, nombre) {
  for (const p of (request.headers.get('Cookie') || '').split(';')) {
    const t = p.trim(); if (t.startsWith(nombre + '=')) return t.slice(nombre.length + 1);
  }
  return null;
}
function b64url(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function firmar(env, oraculo, licencia, dispositivo) {
  const clave = await crypto.subtle.importKey('jwk', JSON.parse(env.OD_CLAVE_FIRMA), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const datos = new TextEncoder().encode('od1|' + oraculo + '|' + licencia + '|' + dispositivo);
  return b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, clave, datos));
}

export async function onRequestPost({ request, env }) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch (e) { return json({ ok: false }); }
  if (!cuerpo || cuerpo.accion !== 'olvidar') return json({ ok: false });
  const token = leerCookie(request, COOKIE);
  // Sin sesión de respaldo no hay nada que olvidar
  if (!token || !/^[a-f0-9]{64}$/.test(token) || !env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ ok: true });
  try {
    const sesion = await kvGet(env, 'od:sesion:' + token);
    if (!sesion || !sesion.licencias) return json({ ok: true });
    const ids = Array.isArray(cuerpo.oraculos) ? cuerpo.oraculos.map(String) : [];
    for (const id of ids) delete sesion.licencias[id];
    await kvSet(env, 'od:sesion:' + token, sesion, UN_ANO);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false });
  }
}

export async function onRequestGet({ request, env }) {
  const token = leerCookie(request, COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return json({ ok: false });
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN || !env.OD_CLAVE_FIRMA) return json({ ok: false });
  try {
    const sesion = await kvGet(env, 'od:sesion:' + token);
    if (!sesion || !sesion.licencias || !sesion.dispositivo) return json({ ok: false });
    const coleccion = [];
    for (const oraculo of Object.keys(sesion.licencias)) {
      const licencia = sesion.licencias[oraculo];
      const lista = await kvGet(env, 'od:dispositivos:' + licencia);
      if (!Array.isArray(lista) || lista.indexOf(sesion.dispositivo) === -1) continue; // se liberó
      coleccion.push({ oraculo, licencia, firma: await firmar(env, oraculo, licencia, sesion.dispositivo) });
    }
    return json({ ok: true, email: sesion.email || '', dispositivo: sesion.dispositivo, coleccion });
  } catch (e) {
    return json({ ok: false });
  }
}
