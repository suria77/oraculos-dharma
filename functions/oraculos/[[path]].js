// Cloudflare Pages Function → /oraculos/*
//
// Puerta de las barajas de pago: antes de entregar una carta, un audio o el archivo de textos
// (cartas.json) de una baraja de pago, comprueba el permiso de acceso (cookie od_acc, HttpOnly,
// firmada por el servidor tras comprobar la licencia). Sin permiso responde 401.
//
// Siempre públicos: la baraja gratis (Atman) y, de las de pago, lo que enseña la página de muestra
// (portada, fondo, dorso, sonido, miniaturas, las 2 cartas de muestra y sus audios recortados de muestra/).

import { BARAJAS_PAGO, leerPermiso } from '../../lib/comun.js';

const PUBLICO = /^(portada\.webp|fondo[^/]*\.webp|dorso\.webp|sonido-giro\.mp3|mini\/[^/]+\.webp|muestra\/[^/]+\.mp3)$/;

function esPublico(id, resto) {
  if (PUBLICO.test(resto)) return true;
  // Solo las imágenes de las 2 cartas de muestra son públicas; los audios completos van con licencia
  // (el audio de muestra, recortado, está en muestra/).
  const m = resto.match(/^([a-z0-9-]+)\.webp$/);
  if (!m) return false;
  const base = m[1].replace(/-2$/, '');
  return BARAJAS_PAGO[id].indexOf(base) !== -1;
}

export async function onRequest({ request, env, params, next }) {
  const partes = Array.isArray(params.path) ? params.path : [params.path];
  const id = partes[0] || '';
  const resto = partes.slice(1).join('/');

  // Atman y cualquier ruta que no sea de una baraja de pago: archivo estático normal
  if (!Object.prototype.hasOwnProperty.call(BARAJAS_PAGO, id)) return next();
  if (esPublico(id, resto)) return next();

  const permiso = await leerPermiso(request, env);
  if (!permiso || permiso.o.indexOf(id) === -1) {
    return new Response('Necesitas activar tu licencia para abrir este oráculo.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const r = await next();
  const h = new Headers(r.headers);
  h.set('Cache-Control', 'private, max-age=86400');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
