// Cloudflare Pages Function → /api/sesion
//
// GET: con la cookie de sesión (od_sess, HttpOnly, la crea activar.js) devuelve los oráculos
//   activados en este dispositivo, firmados de nuevo, y renueva el permiso de acceso (od_acc) a
//   las barajas de pago. La app lo llama al abrirse (como mucho una vez al día) y cuando el móvil ha
//   perdido su colección. Solo se devuelven las licencias en las que este dispositivo sigue siendo
//   uno de los 2 permitidos y que Payhip mantiene activas (un reembolso las desactiva).
//
// POST { accion: 'olvidar', oraculos: ['rumi', …] }
//   Quita esos oráculos de la sesión de ESTE dispositivo y de su permiso (la app lo usa en
//   «Quitar de este dispositivo», para pruebas). No libera la plaza del dispositivo en la licencia.

import {
  COOKIE_SESION, UN_ANO, json, hayUpstash, kvGet, kvSet, dentroDelLimite, leerCookie,
  firmar, cookiePermiso, consultarPayhip,
} from '../../lib/comun.js';

const tokenValido = t => !!t && /^[a-f0-9]{64}$/.test(t);

export async function onRequestPost({ request, env }) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch (e) { return json(400, { ok: false }); }
  if (!cuerpo || cuerpo.accion !== 'olvidar') return json(400, { ok: false });
  const token = leerCookie(request, COOKIE_SESION);
  // Sin sesión de respaldo no hay nada que olvidar
  if (!tokenValido(token) || !hayUpstash(env)) return json(200, { ok: true });
  try {
    const sesion = await kvGet(env, 'od:sesion:' + token);
    if (!sesion || !sesion.licencias) return json(200, { ok: true });
    const ids = Array.isArray(cuerpo.oraculos) ? cuerpo.oraculos.map(String) : [];
    for (const id of ids) delete sesion.licencias[id];
    await kvSet(env, 'od:sesion:' + token, sesion, UN_ANO);
    const p = await cookiePermiso(env, sesion.dispositivo, Object.keys(sesion.licencias));
    return json(200, { ok: true, accesoHasta: p.hasta }, [p.cookie]);
  } catch (e) {
    return json(200, { ok: false });
  }
}

export async function onRequestGet({ request, env }) {
  const token = leerCookie(request, COOKIE_SESION);
  if (!tokenValido(token)) return json(200, { ok: false });
  if (!hayUpstash(env) || !env.OD_CLAVE_FIRMA) return json(200, { ok: false });
  if (!(await dentroDelLimite(env, request, 'sesion', 30, 60))) return json(429, { ok: false });
  try {
    const sesion = await kvGet(env, 'od:sesion:' + token);
    if (!sesion || !sesion.licencias || !sesion.dispositivo) return json(200, { ok: false });
    const coleccion = [], desactivadas = [];
    let cambios = false;
    for (const oraculo of Object.keys(sesion.licencias)) {
      const licencia = sesion.licencias[oraculo];
      const lista = await kvGet(env, 'od:dispositivos:' + licencia);
      if (!Array.isArray(lista) || lista.indexOf(sesion.dispositivo) === -1) {   // se liberó
        desactivadas.push(oraculo); delete sesion.licencias[oraculo]; cambios = true; continue;
      }
      // Reembolso: Payhip desactiva la licencia. Si Payhip no responde, se deja como está.
      let p = null;
      try { p = await consultarPayhip(env, licencia, 6 * 3600); } catch (e) { p = undefined; }
      if (p === null || (p && p.oraculo && (p.enabled === false || p.oraculo !== oraculo))) {
        desactivadas.push(oraculo); delete sesion.licencias[oraculo]; cambios = true; continue;
      }
      coleccion.push({ oraculo, licencia, firma: await firmar(env, oraculo, licencia, sesion.dispositivo) });
    }
    if (cambios) await kvSet(env, 'od:sesion:' + token, sesion, UN_ANO).catch(() => {});
    const permiso = await cookiePermiso(env, sesion.dispositivo, coleccion.map(c => c.oraculo));
    return json(200, {
      ok: true, email: sesion.email || '', dispositivo: sesion.dispositivo, coleccion, desactivadas,
      accesoHasta: permiso.hasta,
    }, [permiso.cookie]);
  } catch (e) {
    return json(200, { ok: false });
  }
}
