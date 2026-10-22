// Cloudflare Pages Function → GET /api/estado
// Diagnóstico: dice SI están puestas las variables (nunca enseña su valor) y si responden.
// Para no dar pistas a extraños, el detalle solo se ve con la clave de diagnóstico:
//   1. En Cloudflare añade la variable ESTADO_CLAVE (tipo "Secret") con una palabra que elijas.
//   2. Abre https://<tu-dominio>/api/estado?clave=<esa palabra>
// Sin la clave, solo responde si el sistema de licencias está listo o no.

import { dentroDelLimite } from '../../lib/comun.js';

const responder = cuerpo => new Response(JSON.stringify(cuerpo, null, 2), {
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export async function onRequestGet({ request, env }) {
  if (!(await dentroDelLimite(env, request, 'estado', 10, 60))) return responder({ listo: 'espera un minuto' });
  const oraculos = Object.keys(env)
    .filter((k) => k.startsWith('PAYHIP_SECRET_') && env[k])
    .map((k) => k.slice('PAYHIP_SECRET_'.length).toLowerCase().replace(/_/g, '-'));

  let firma = 'falta';
  if (env.OD_CLAVE_FIRMA) {
    try {
      const jwk = JSON.parse(env.OD_CLAVE_FIRMA);
      await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      firma = 'ok';
    } catch (e) { firma = 'mal copiada'; }
  }

  let upstash = 'falta';
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const r = await fetch(env.UPSTASH_REDIS_REST_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(['PING']),
      });
      const d = await r.json().catch(() => null);
      upstash = d && d.result === 'PONG' ? 'ok' : 'no responde (revisa la URL y el token)';
    } catch (e) { upstash = 'no responde (revisa la URL)'; }
  }

  const listo = firma === 'ok' && upstash === 'ok' && oraculos.length > 0;
  const clave = new URL(request.url).searchParams.get('clave') || '';
  if (!env.ESTADO_CLAVE || clave !== env.ESTADO_CLAVE) return responder({ listo });
  return responder({
    listo,
    firma_OD_CLAVE_FIRMA: firma,
    upstash: upstash,
    payhip_oraculos_configurados: oraculos.length ? oraculos : 'ninguno',
  });
}
