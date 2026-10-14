// Cloudflare Pages Function → GET /api/estado
// Diagnóstico: dice SI están puestas las variables (nunca enseña su valor) y si responden.
// Abre https://<tu-dominio>/api/estado para comprobar la configuración.

export async function onRequestGet({ env }) {
  const oraculos = Object.keys(env)
    .filter((k) => k.startsWith('PAYHIP_SECRET_') && env[k])
    .map((k) => k.slice('PAYHIP_SECRET_'.length).toLowerCase());

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

  return new Response(JSON.stringify({
    firma_OD_CLAVE_FIRMA: firma,
    upstash: upstash,
    payhip_oraculos_configurados: oraculos.length ? oraculos : 'ninguno',
  }, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
