#!/usr/bin/env python3
"""Genera offline-files.js: la lista de archivos que la app puede guardar en el móvil.

Uso (desde la carpeta del repo):   python3 tools/make-offline-list.py
Hay que volver a ejecutarlo siempre que se añadan, quiten o renombren imágenes, audios
u oráculos (carpetas dentro de oraculos/).

 - core:      interfaz (index, iconos, imágenes de img/): se guarda sola al abrir la app
 - oraculos:  por cada oráculo, sus imágenes y sus audios. Las imágenes se guardan solas al
              abrir el oráculo; los audios al escucharlos o con "Guardar sin conexión".
Los vídeos no se incluyen (van por red; si no hay conexión se ve la imagen fija).
Las capturas del tutorial (img/instalar) tampoco: se guardan solas al abrir el tutorial.
Las miniaturas (mini/) solo las usa la página de muestra y no se guardan con el oráculo.
Cada carta, texto y audio lleva una huella: si cambias un archivo sin cambiarle el nombre,
los móviles borran su copia vieja al actualizarse.
"""
import hashlib, json, os
from urllib.parse import quote

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
VERSION = 'v20'          # súbelo (v2, v3...) para obligar a todos los móviles a bajar la interfaz de nuevo
IMG_EXT = {'.png', '.webp', '.jpg', '.jpeg', '.svg', '.gif', '.ico', '.avif'}
FONT_EXT = {'.ttf', '.otf', '.woff', '.woff2'}
AUDIO_EXT = {'.mp3', '.m4a', '.wav', '.ogg', '.aac'}

core, core_sz = ['./', 'manifest.webmanifest', 'offline.js', 'offline-files.js'], [0, 0, 0, 0]
for carpeta in ('img', 'fonts'):
    base = os.path.join(ROOT, carpeta)
    if not os.path.isdir(base):
        continue
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(x for x in dirnames if x != 'instalar')
        for fn in sorted(filenames):
            ext = os.path.splitext(fn)[1].lower()
            if fn == 'og.jpg':          # imagen para redes sociales: la app no la usa
                continue
            if ext in IMG_EXT or ext in FONT_EXT:
                rel = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace(os.sep, '/')
                core.append(quote(rel)); core_sz.append(os.path.getsize(os.path.join(dirpath, fn)))

def huella(ruta):
    with open(ruta, 'rb') as fh:
        return hashlib.sha1(fh.read()).hexdigest()[:10]

oraculos, huellas = {}, {}
base = os.path.join(ROOT, 'oraculos')
for oid in sorted(os.listdir(base)) if os.path.isdir(base) else []:
    d = os.path.join(base, oid)
    if not os.path.isdir(d):
        continue
    o = {'images': [], 'imagesSz': [], 'audio': [], 'audioSz': []}
    for dirpath, dirnames, filenames in os.walk(d):
        dirnames[:] = sorted(x for x in dirnames if x != 'mini')
        for fn in sorted(filenames):
            ext = os.path.splitext(fn)[1].lower()
            ruta = os.path.join(dirpath, fn)
            rel = quote(os.path.relpath(ruta, ROOT).replace(os.sep, '/'))
            size = os.path.getsize(ruta)
            if ext in AUDIO_EXT:
                o['audio'].append(rel); o['audioSz'].append(size)
            elif ext in IMG_EXT or fn == 'cartas.json':
                o['images'].append(rel); o['imagesSz'].append(size)
            else:
                continue
            huellas[rel] = huella(ruta)
    oraculos[oid] = o

cfg = {
    'version': VERSION,
    'caches': {'shell': 'od-shell-' + VERSION, 'assets': 'od-assets-v1', 'media': 'od-media-v2'},
    'core': core, 'coreSz': core_sz, 'oraculos': oraculos, 'huellas': huellas,
}
with open(os.path.join(ROOT, 'offline-files.js'), 'w', encoding='utf-8') as f:
    f.write('/* Generado por tools/make-offline-list.py — no editar a mano */\n')
    f.write('self.OD_OFFLINE = ' + json.dumps(cfg, ensure_ascii=False, separators=(',', ':')) + ';\n')
print('core %d archivos (%.1f MB)' % (len(core), sum(core_sz) / 1e6))
for oid, o in oraculos.items():
    print('  %s: %d imágenes (%.1f MB) · %d audios (%.1f MB)' % (
        oid, len(o['images']), sum(o['imagesSz']) / 1e6, len(o['audio']), sum(o['audioSz']) / 1e6))
