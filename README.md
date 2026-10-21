# Oráculos del Dharma

App web instalable (PWA) con los oráculos de Dharma Eterno. Se aloja en Cloudflare Pages
conectado a este repositorio.

## Variables en Cloudflare (Settings → Variables and Secrets)

| Nombre | Qué es |
|---|---|
| `PAYHIP_SECRET_ATMAN`, `PAYHIP_SECRET_RUMI`, `PAYHIP_SECRET_GURU`, `PAYHIP_SECRET_DIOSES_INDIA` | Product secret key de cada oráculo en Payhip. Lo que va detrás de `PAYHIP_SECRET_` es el `id` del oráculo en `index.html` (los guiones se escriben como `_`). |
| `OD_CLAVE_FIRMA` | Clave privada para firmar las licencias (tipo *Secret*). Nunca se sube al repositorio. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Las mismas de Japa-Móvil (límite de 2 dispositivos y sesión de respaldo). |

## Cómo se protege la colección

1. **Payhip**: licencia activa y correo del comprador.
2. **2 dispositivos por licencia**, con opción de liberar el más antiguo (Upstash).
3. **Firma digital**: cada oráculo abierto lleva una firma ligada al dispositivo; escribir a mano en la memoria del móvil no abre nada.
4. **Guardado triple** en el móvil (localStorage + cookie + IndexedDB) que se autocura, más `navigator.storage.persist()`.
5. **Copia en el servidor** (cookie HttpOnly de 1 año, `/api/sesion`): si el móvil lo borra todo, la colección se recupera sola.
6. **Revisión semanal** silenciosa: si hay reembolso o se libera el dispositivo, el oráculo se cierra.

## Uso sin conexión

`sw.js` guarda la interfaz y las cartas; los audios se guardan al escucharlos o con el botón
«Guardar sin conexión» de cada oráculo. El vídeo de cabecera va por red (sin conexión se ve la imagen fija).

**Siempre que se añadan, quiten o renombren imágenes, audios u oráculos**, hay que regenerar la lista:

```
python3 tools/make-offline-list.py
```

Para obligar a todos los móviles a bajar la interfaz nueva, sube `VERSION` en ese script.
