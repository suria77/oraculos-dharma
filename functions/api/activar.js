// Cloudflare Pages Function → responde en /api/activar
//
// Comprueba una licencia de Payhip y devuelve a qué oráculo pertenece.
// La clave secreta de cada producto NUNCA va en la página: se guarda en
// Cloudflare → tu proyecto de Pages → Settings → Variables and Secrets,
// una por oráculo, con este formato de nombre:
//
//   PAYHIP_SECRET_ATMAN   = (Product secret key del producto Atman en Payhip)
//   PAYHIP_SECRET_RUMI    = (la del producto Rumi, cuando exista)
//
// La parte final del nombre (ATMAN, RUMI…) en minúsculas debe coincidir con
// el "id" del oráculo en index.html (atman, rumi…).

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export async function onRequestPost({ request, env }) {
  let licencia = '';
  try {
    const cuerpo = await request.json();
    licencia = String(cuerpo.licencia || '').trim();
  } catch (e) {
    return json({ ok: false, error: 'Petición no válida.' }, 400);
  }
  if (!licencia || licencia.length > 80) {
    return json({ ok: false, error: 'Escribe o pega tu licencia.' }, 400);
  }

  const productos = Object.entries(env)
    .filter(([nombre, valor]) => nombre.startsWith('PAYHIP_SECRET_') && valor)
    .map(([nombre, secreto]) => ({ id: nombre.slice('PAYHIP_SECRET_'.length).toLowerCase(), secreto }));

  if (!productos.length) {
    return json({ ok: false, error: 'El sistema de licencias aún no está configurado.' }, 500);
  }

  // Se prueba la licencia contra cada producto hasta encontrar el suyo.
  for (const { id, secreto } of productos) {
    let datos = null;
    try {
      const r = await fetch(
        'https://payhip.com/api/v2/license/verify?license_key=' + encodeURIComponent(licencia),
        { headers: { 'product-secret-key': secreto } }
      );
      const texto = await r.text();
      if (texto) datos = JSON.parse(texto).data;
    } catch (e) {
      continue;
    }
    if (!datos) continue; // esta licencia no es de este producto
    if (datos.enabled) return json({ ok: true, oraculo: id });
    return json({
      ok: false,
      desactivada: true,
      error: 'Esta licencia está desactivada. Si crees que es un error, escríbenos.',
    });
  }

  return json({
    ok: false,
    error: 'No encontramos esa licencia. Revisa que esté completa, con sus guiones, tal como aparece en tu email de Payhip.',
  });
}

export const onRequestGet = () => json({ ok: false, error: 'Usa POST.' }, 405);
