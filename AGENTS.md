# AGENTS.md

Guia para agentes que trabajen en este proyecto.

## Objetivo del proyecto

Construir y mantener un editor PDF web local, enfocado en edicion visualmente fiel de PDFs existentes. La prioridad es conservar posicion, tamano, fuente, color, densidad de negrita, lineas vectoriales e imagenes al reemplazar contenido.

## Stack

- Frontend: Vite + React + TypeScript.
- Estilos: CSS en `src/style.css`.
- Backend: FastAPI + PyMuPDF en `server/app.py`.
- Runtime temporal: `.pdf_editor_storage/`.
- Script combinado: `scripts/dev-all.mjs`.
- Despliegue: Docker en Render.

## Comandos importantes

```powershell
npm run dev:all
npm run dev
npm run api
npm run build
python -m py_compile server\app.py
```

No dejes servidores corriendo al finalizar una tarea, salvo que el usuario lo pida explicitamente. El usuario normalmente prefiere arrancar la app desde terminal.

## Despliegue

Render debe usar runtime Docker. El servicio arranca con:

```sh
uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-10000}
```

El backend sirve el frontend compilado desde `dist/` cuando existe. No crear un Static Site separado salvo que tambien se configure un backend aparte; esta app necesita Python para analizar y exportar PDFs.

## Mapa de archivos

- `src/main.tsx`: UI principal, estado de documento, boxes, seleccion, teclado, inspector, exportacion.
- `src/style.css`: layout, boxes, handles, overlays y controles visuales.
- `server/app.py`: API, extraccion PDF, render, preview, exportacion y calibracion de texto.
- `scripts/dev-all.mjs`: levanta backend y frontend juntos.
- `public/favicon.svg` / `public/favicon.ico`: icono local.
- `README.md`: documentacion de uso y arquitectura.
- `Dockerfile`: despliegue Docker para Render.
- `.dockerignore`: excluye dependencias, build local y PDFs temporales.
- `render.yaml`: Blueprint opcional para Render.

## Reglas de trabajo

- Usa patrones existentes; evita reescrituras grandes si un cambio puntual basta.
- No agregues dependencias si PyMuPDF, React o CSS nativo resuelven el problema.
- Manten los controles visuales pequenos: los PDFs pueden tener boxes muy chicos y densos.
- Conserva el flujo de doble click para editar texto y click fuera para confirmar.
- Las flechas del teclado deben servir para precision, no deben interferir con inputs activos.
- No borres cambios del usuario ni reviertas archivos completos sin permiso.
- No versionar `.pdf_editor_storage/`; contiene PDFs cargados temporalmente.

## Detalles criticos del backend

La exportacion de texto usa redaccion + reinsercion:

1. `replace_text` y `delete_text` agregan redaccion sobre `originalRect`.
2. `page.apply_redactions` usa `graphics=fitz.PDF_REDACT_LINE_ART_NONE` para no borrar lineas cruzadas.
3. `insert_text_operation` reinserta el texto.
4. Si hay `origin` y el texto es de una linea, usar `insert_text` en el punto original.
5. Si no hay origen o hay multilinea, usar `insert_textbox`.

La negrita visual no debe decidirse solo por nombre de fuente. Algunos PDFs usan `ArialMT` normal con tinta densa. La funcion mide `fontInkDensity` y prueba variantes de trazo hasta acercarse al original.

Fuentes embebidas y subsets:

- Si una fuente tiene `ToUnicode`, intenta reutilizar el recurso original codificando el texto nuevo con los codigos internos del PDF.
- No uses Unicode directo contra recursos subset si el texto puede desaparecer, cambiar a cuadros o perder letras.
- Si el texto nuevo contiene glifos que no existen en el subset embebido, usa fallback local parecido; no fuerces la fuente original.
- Para textos pequenos tipo codigos numericos largos, conserva la calibracion compacta para evitar que queden anchos, bajos o achatados.
- Evita `Tz` como solucion general de ancho porque deforma glifos; prefiere ajustar espaciado (`Tc`) cuando aplique.

Al modificar la calibracion:

- Prueba textos tipo titulo (`Estado de Cuenta Tarjeta Visa`).
- Prueba labels medianos (`Linea de credito`).
- Prueba texto monoespaciado/italico de tablas.
- Prueba tickets con fuentes subset (`NeuePlak`, `Omnes`) y codigos numericos bajo QR.
- Reporta densidad objetivo y densidad nueva.

## Detalles criticos del frontend

Los cambios de texto viven en `textEdits`. Cada `TextEdit` conserva:

- `span`: span original.
- `text`: texto nuevo.
- `rect`: box editable/exportable.
- `origin`: punto base para reinsercion.
- `fontFamily`, `fontSize`, `fontFlags`, `fontXref`, `fontResource`, `fontInkDensity`, `color`.

Los cambios exportables se construyen en `buildOperations()`.

Interaccion:

- El doble click sobre texto abre editor inline; click fuera confirma.
- El estado `drag` debe limpiarse tambien con `pointerup`/`pointercancel` global para evitar hojas bloqueadas si el evento se captura fuera de la pagina.
- No desactives eventos de `.text-box` sin reemplazar completamente la seleccion; son el punto de entrada principal para editar boxes.
- La preview automatica puede estar desactivada; si `AUTO_PREVIEW` es `false`, evita construir operaciones solo para descartarlas.
- El zoom debe mantenerse sincronizado entre botones, rueda y campo numerico porcentual. Usa `MIN_ZOOM`, `MAX_ZOOM` y `clampZoom`; no dupliques limites magicos.
- En UI, la herramienta `redact` debe mostrarse como `Ocultar` porque cubre/censura contenido, no edita texto narrativo.
- `highlight`, `redact` y `rectangle` son herramientas de dibujo: deben poder iniciar el trazo sobre boxes de texto, imagenes, vectores u operaciones existentes, sin disparar seleccion/movimiento.

Movimiento:

- Mouse: `startMove`.
- Inspector: actualiza `rect` y `origin`.
- Teclado: `moveSelectedBy`.

Resize:

- Mouse: `startResize` + `resizeRect`.
- Teclado: `resizeSelectedBy`.
- Handles permitidos: `n`, `e`, `s`, `w`, `nw`, `ne`, `se`, `sw`.

Cuando se mueve texto, actualiza tambien `origin`. Si se mueve un borde norte/oeste al redimensionar texto, ajusta `origin` por el cambio de `x0`/`y0`.

## Verificacion antes de entregar

Minimo:

```powershell
npm run build
python -m py_compile server\app.py
```

Si `npm run build` falla por el wrapper de PowerShell de npm, repetir con:

```powershell
npm.cmd run build
```

Si se tocan puertos o scripts de dev, comprobar:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8000,5173,5174 -ErrorAction SilentlyContinue
```

Si hay procesos escuchando que el agente inicio, cerrarlos antes de responder.

## Limpieza de PDFs

`.pdf_editor_storage/` es almacenamiento temporal. Se puede borrar para limpiar PDFs de prueba; el backend la recrea al cargar otro PDF.

No borres PDFs fuera del workspace, por ejemplo documentos del Escritorio del usuario, salvo que el usuario pida esa ruta exacta.
