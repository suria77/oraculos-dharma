// Cloudflare Pages Function → POST /api/activar
//
// Comprueba una licencia de Payhip, averigua de qué oráculo es y la "firma" para este
// dispositivo. Capas de seguridad:
//
//  1. Payhip: la licencia existe, está activa (si hay reembolso Payhip la desactiva) y el
//     correo coincide con el del comprador.
//  2. Máximo 2 dispositivos por licencia (con opción de liberar el más antiguo, una vez al mes),
//     guardado en Upstash Redis. Si Upstash no responde, NO se activa (falla en cerrado).
//  3. Firma digital del oráculo para la app (la comprueba con la clave pública).
//  4. Permiso de acceso (cookie od_acc, HttpOnly, 30 días): sin él, el servidor no entrega ninguna
//     carta, audio ni texto de una baraja de pago (ver functions/oraculos/[[path]].js).
//  5. Sesión de respaldo (cookie od_sess, HttpOnly, 1 año) con los oráculos de este dispositivo.
//  6. Límite de peticiones por IP.
//
// VARIABLES en Cloudflare → proyecto → Settings → Variables and Secrets:
//   PAYHIP_SECRET_ATMAN, PAYHIP_SECRET_RUMI…  (Product secret key de cada producto en Payhip)
//   OD_CLAVE_FIRMA                             (la clave privada, tipo "Secret")
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// Acciones (campo "accion" del cuerpo):
//   "activar"   → { email, licencia, dispositivo, liberar }
//   "comprobar" → { licencia, dispositivo }   (revisión semanal silenciosa)

import {
  MAX_DISPOSITIVOS, COOKIE_SESION, UN_ANO, json, hayUpstash, kvGet, kvSet, dentroDelLimite,
  leerCookie, cookieSesion, nuevoToken, firmar, cookiePermiso, productos, consultarPayhip,
} from '../../lib/comun.js';

const LIBERAR_CADA_DIAS = 30;
const OCUPADO = 'No podemos comprobar licencias en este momento. Inténtalo de nuevo en unos minutos.';

export async function onRequestPost({ request, env }) {
  let cuerpo;
  try { cuerpo = await request.json(); } catch (e) { return json(400, { ok: false, error: 'Petición no válida.' }); }
  if (!cuerpo || typeof cuerpo !== 'object') return json(400, { ok: false, error: 'Petición no válida.' });

  const accion = cuerpo.accion === 'comprobar' ? 'comprobar' : 'activar';
  const licencia = String(cuerpo.licencia || '').trim().toUpperCase();
  const email = String(cuerpo.email || '').trim().toLowerCase();
  const dispositivo = String(cuerpo.dispositivo || '').trim();

  if (!licencia || licencia.length > 80 || !/^[A-Z0-9-]+$/.test(licencia)) return json(400, { ok: false, error: 'Escribe o pega tu licencia completa, con sus guiones.' });
  if (!/^[A-Za-z0-9-]{8,64}$/.test(dispositivo)) return json(400, { ok: false, error: 'Falta el identificador del dispositivo.' });
  if (accion === 'activar' && !email) return json(400, { ok: false, error: 'Escribe el correo con el que hiciste la compra.' });
  if (!productos(env).length || !env.OD_CLAVE_FIRMA || !hayUpstash(env)) {
    return json(503, { ok: false, error: 'El sistema de licencias está en mantenimiento. Inténtalo de nuevo más tarde.' });
  }

  // 0. Límite de peticiones (evita ataques que agoten Upstash o hagan que Payhip bloquee la tienda)
  const maxMin = accion === 'activar' ? 20 : 40;
  if (!(await dentroDelLimite(env, request, accion, maxMin, 60))) {
    return json(429, { ok: false, error: 'Demasiados intentos seguidos. Espera un minuto y vuelve a probar.' });
  }

  // 1. Payhip (respuesta recordada 10 min al activar, 6 h en la revisión semanal)
  let encontrada;
  try { encontrada = await consultarPayhip(env, licencia, accion === 'activar' ? 600 : 6 * 3600); }
  catch (e) { return json(503, { ok: false, error: OCUPADO }); }
  if (!encontrada) {
    return json(200, { ok: false, error: 'No encontramos esa licencia. Revisa que esté completa, con sus guiones, tal como aparece en tu email de Payhip.' });
  }
  if (encontrada.producto !== undefined) {
    return json(200, { ok: false, error: 'La licencia es válida, pero ese producto todavía no está disponible en la app (código: ' + (encontrada.producto || 'desconocido') + '). Escríbenos y lo resolvemos enseguida.' });
  }
  const { oraculo } = encontrada;
  if (!encontrada.enabled) {
    return json(200, { ok: false, desactivada: true, error: 'Esta licencia está desactivada (por ejemplo, por un reembolso). Si crees que es un error, escríbenos.' });
  }
  if (accion === 'activar' && (!encontrada.email || encontrada.email !== email)) {
    return json(200, { ok: false, error: 'Esa licencia no corresponde a ese correo. Usa el correo con el que hiciste la compra.' });
  }

  // 2. Dispositivos (si Upstash falla, no se activa: así el límite nunca se salta)
  const claveDisp = 'od:dispositivos:' + licencia;
  let lista;
  try { const g = await kvGet(env, claveDisp); lista = Array.isArray(g) ? g : []; }
  catch (e) { return json(503, { ok: false, error: OCUPADO }); }

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
      // Liberar solo una vez cada 30 días: si una licencia se filtra, nadie puede echar al comprador una y otra vez
      const claveLib = 'od:liberado:' + licencia;
      try {
        if (await kvGet(env, claveLib)) {
          return json(200, { ok: false, error: 'Ya liberaste un dispositivo este mes con esta licencia. Si necesitas cambiar otra vez, escríbenos y te ayudamos.' });
        }
        await kvSet(env, claveLib, Date.now(), LIBERAR_CADA_DIAS * 86400);
      } catch (e) { return json(503, { ok: false, error: OCUPADO }); }
      lista = lista.slice(lista.length - MAX_DISPOSITIVOS + 1);
    }
    lista.push(dispositivo);
    try { await kvSet(env, claveDisp, lista); }
    catch (e) { return json(503, { ok: false, error: OCUPADO }); }
  }

  // 3. Firma
  const firma = await firmar(env, oraculo, licencia, dispositivo);
  if (accion === 'comprobar') return json(200, { ok: true, oraculo, licencia, firma });

  // 4 y 5. Sesión de respaldo + permiso de acceso con todas las barajas de este dispositivo
  const cookies = [];
  let accesoHasta = 0;
  try {
    let token = leerCookie(request, COOKIE_SESION);
    let sesion = null;
    if (token && /^[a-f0-9]{64}$/.test(token)) sesion = await kvGet(env, 'od:sesion:' + token);
    if (!sesion || sesion.dispositivo !== dispositivo) { token = nuevoToken(); sesion = { dispositivo, email, licencias: {} }; }
    sesion.licencias[oraculo] = licencia;
    sesion.email = email;
    await kvSet(env, 'od:sesion:' + token, sesion, UN_ANO);
    cookies.push(cookieSesion(token));

    const permitidos = [oraculo];
    for (const [otro, lic] of Object.entries(sesion.licencias)) {
      if (otro === oraculo) continue;
      const l = await kvGet(env, 'od:dispositivos:' + lic).catch(() => null);
      if (Array.isArray(l) && l.indexOf(dispositivo) !== -1) permitidos.push(otro);
    }
    const p = await cookiePermiso(env, dispositivo, permitidos);
    cookies.push(p.cookie); accesoHasta = p.hasta;
  } catch (e) {
    // Sin sesión ni permiso la licencia queda activada igual; la app volverá a pedir el permiso
    const p = await cookiePermiso(env, dispositivo, [oraculo]);
    cookies.push(p.cookie); accesoHasta = p.hasta;
  }

  return json(200, { ok: true, oraculo, licencia, firma, accesoHasta }, cookies);
}

export const onRequestGet = () => json(405, { ok: false, error: 'Usa POST.' });
