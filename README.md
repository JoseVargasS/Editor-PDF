# Editor PDF

Aplicacion web local para editar PDFs con la mayor fidelidad posible: detectar textos existentes, respetar posicion, fuente, tamano, color, densidad visual de negrita, lineas vectoriales e imagenes, y exportar un PDF modificado.

La app esta pensada para correr en tu maquina, sin subir documentos a servicios externos. El frontend corre con Vite/React y el backend usa FastAPI + PyMuPDF para analizar, previsualizar y exportar PDFs.

## Estado actual

- Abre PDFs desde boton o arrastrando el archivo a la ventana.
- Renderiza cada pagina como imagen base para mantener el PDF visualmente estable.
- Detecta spans de texto con caja, fuente, tamano, color, flags, recurso PDF, xref de fuente y densidad de tinta.
- Permite seleccionar, mover, redimensionar, editar y revertir boxes.
- Edita texto con doble click y conserva una sola linea cuando el texto original es de una sola linea.
- Mueve boxes con mouse, campos X/Y del inspector y flechas del teclado.
- Redimensiona boxes con campos del inspector, `Ctrl`/`Cmd` + flechas y agarraderas pequenas tipo editor clasico.
- Exporta reemplazos de texto con redaccion transparente del texto original y reinsercion calibrada.
- Preserva lineas/vectoriales cruzadas al aplicar redacciones de texto.
- Reusa fuentes embebidas subset cuando el PDF trae mapa `ToUnicode`, codificando texto nuevo con los codigos internos del PDF.
- Usa fallback de fuente local parecida cuando el texto nuevo contiene glifos que no existen en el subset embebido.
- Calibra textos pequenos tipo codigos numericos para evitar que queden anchos, bajos o deformados.
- Permite agregar texto, imagenes, rectangulos, resaltados y areas para ocultar/censurar contenido.
- Las herramientas `Marcador` y `Ocultar` funcionan como pinceles: se arrastra directamente sobre el area del PDF, incluso empezando encima de texto detectado.
- Incluye favicon local para evitar errores 404.

## Comandos

Instalar dependencias de JavaScript:

```powershell
npm install
```

Instalar dependencias de Python:

```powershell
pip install -r requirements.txt
```

Arrancar frontend y backend juntos:

```powershell
npm run dev:all
```

Arrancar solo frontend:

```powershell
npm run dev
```

Arrancar solo backend:

```powershell
npm run api
```

Compilar frontend:

```powershell
npm run build
```

Si PowerShell muestra avisos del wrapper de npm, se puede usar directamente:

```powershell
npm.cmd run build
```

Validar sintaxis Python:

```powershell
python -m py_compile server\app.py
```

## Puertos

- Frontend Vite: `http://127.0.0.1:5173`
- Backend FastAPI: `http://127.0.0.1:8000`

El script `npm run dev:all` levanta ambos procesos y los cierra juntos al presionar `Ctrl+C`.

## Despliegue en Render

La app se despliega en Render como un solo `Web Service` Docker. El Dockerfile compila React y despues arranca FastAPI sirviendo tanto `/api/...` como el frontend compilado.

Archivos usados para despliegue:

- `Dockerfile`: build multi-stage Node + Python.
- `.dockerignore`: evita subir `node_modules`, `dist`, PDFs temporales y archivos locales.
- `render.yaml`: configuracion opcional de Render Blueprint.

Pasos recomendados:

1. Sube este proyecto a GitHub.
2. En Render, ve a `New` -> `Web Service`.
3. Conecta el repositorio.
4. Selecciona runtime `Docker` si Render no lo detecta automaticamente.
5. Usa plan `Free` o el plan que prefieras.
6. Confirma que el servicio use el `Dockerfile` de la raiz.
7. Deploy.

Render exige que los Web Services escuchen en `0.0.0.0` y en el puerto que indique la variable `PORT`. El `Dockerfile` ya arranca:

```sh
uvicorn server.app:app --host 0.0.0.0 --port ${PORT:-10000}
```

Cuando Render termine, la app quedara disponible en una URL tipo:

```text
https://editor-pdf.onrender.com
```

### Seguridad en internet

Esta app procesa PDFs que pueden contener informacion sensible. Si la URL queda publica, cualquier persona con el enlace podria usar tu servicio. Para uso personal, lo recomendable es:

- Mantener la URL privada.
- No compartir el enlace.
- Considerar agregar autenticacion simple antes de usarla con documentos sensibles en internet.

### Persistencia en Render

`.pdf_editor_storage/` es almacenamiento runtime. En Render Free el disco del contenedor puede ser efimero: si el servicio reinicia, los PDFs cargados pueden desaparecer. Esto esta bien para el flujo actual porque el usuario carga, edita y exporta en una misma sesion.

## Uso

1. Ejecuta `npm run dev:all`.
2. Abre `http://127.0.0.1:5173`.
3. Carga un PDF con `Abrir` o arrastrandolo a la ventana.
4. Haz click en un texto, imagen u operacion para seleccionarlo.
5. Haz doble click sobre un texto para editarlo inline.
6. Haz click fuera del input para terminar la edicion.
7. Usa `Exportar` para descargar el PDF final.

## Controles de precision

Movimiento:

- Arrastrar con el mouse: mueve el box seleccionado.
- Inspector `X` / `Y`: mueve por coordenadas.
- Flechas: mueve 1 punto.
- `Shift` + flechas: mueve 10 puntos.
- `Alt` + flechas: mueve 0.25 puntos.

Tamano:

- Agarraderas del box seleccionado: redimensionan desde bordes y esquinas.
- Inspector `Ancho` / `Alto`: cambia medidas exactas.
- `Ctrl`/`Cmd` + flechas: cambia ancho/alto desde el borde derecho/inferior.
- `Shift` + `Ctrl`/`Cmd` + flechas: cambia tamano en pasos de 10 puntos.
- `Alt` + `Ctrl`/`Cmd` + flechas: cambia tamano en pasos de 0.25 puntos.

Revertir:

- Al pasar el mouse por un box modificado aparece un boton pequeno de revertir en la esquina superior derecha.

Marcado:

- `Marcador`: crea una franja amarilla semitransparente sobre el area seleccionada.
- `Ocultar`: crea una franja negra opaca para cubrir contenido.
- Ambas herramientas pueden empezar el trazo encima de textos, imagenes u operaciones existentes.

Zoom:

- Botones `-` / `+`: acercan o alejan en pasos rapidos.
- `Ctrl`/`Cmd` + rueda: acerca o aleja manteniendo el punto bajo el cursor.
- Campo porcentual: permite escribir un valor exacto entre `45` y `220`.

## Arquitectura

### Frontend

Archivo principal: `src/main.tsx`

Responsabilidades:

- Gestionar carga de PDFs y fallback entre proxy `/api` y API directa `http://127.0.0.1:8000/api`.
- Mantener estado de documento, seleccion, zoom, ediciones de texto, ediciones de imagen y operaciones nuevas.
- Pintar cada pagina con una imagen base del backend.
- Superponer boxes interactivos para texto, imagenes, dibujos y operaciones.
- Crear operaciones exportables a partir de los cambios del usuario.
- Solicitar previews renderizadas cuando hay cambios.
- Permitir movimiento, resize, edicion inline, inspector y teclado.
- Cerrar interacciones de puntero a nivel global para evitar estados de drag pegados si el `pointerup` cae fuera del box.
- Evitar trabajo innecesario de preview automatico cuando `AUTO_PREVIEW` esta desactivado.
- Sincronizar el zoom entre botones, rueda y campo porcentual editable.

Archivo de estilos: `src/style.css`

Responsabilidades:

- Layout de app, toolbar, sidebar, canvas, inspector y drop zone.
- Estilos de boxes, seleccion, handles, botones de revertir y overlays.
- Mantener controles pequenos para no tapar contenido de PDFs densos.
- Usar `content-visibility` y containment para que documentos largos sean mas livianos en navegadores modernos.

### Backend

Archivo principal: `server/app.py`

Responsabilidades:

- Recibir PDFs y guardarlos en almacenamiento runtime local.
- Analizar paginas con PyMuPDF.
- Extraer textos, imagenes, dibujos y fuentes.
- Renderizar paginas originales como PNG.
- Aplicar operaciones sobre copias del PDF.
- Renderizar previews despues de cambios.
- Exportar el PDF final.

Endpoints:

- `GET /api/health`: health check.
- `POST /api/documents`: carga PDF.
- `GET /api/documents/{document_id}`: vuelve a analizar documento.
- `GET /api/documents/{document_id}/pages/{page_index}/image`: render original.
- `POST /api/documents/{document_id}/pages/{page_index}/preview`: render con operaciones.
- `POST /api/documents/{document_id}/export`: exporta PDF editado.

## Como funciona la edicion de texto

1. El backend extrae cada span con `page.get_text("dict")`.
2. Se guardan posicion, origen, fuente, tamano, color, flags y recurso de fuente.
3. El frontend crea un box encima del texto detectado.
4. Al editar, el frontend manda una operacion `replace_text`.
5. El backend aplica una redaccion transparente sobre el texto original.
6. Luego reinserta el texto nuevo en el origen original cuando es una sola linea.
7. Si la fuente embebida tiene `ToUnicode`, intenta codificar el texto nuevo con los codigos internos del PDF y reutilizar el recurso original.
8. Si el subset no contiene algun glifo nuevo, usa una fuente local parecida en vez de producir letras faltantes o cuadros.
9. Para conservar negrita visual, calibra el texto nuevo contra la densidad de tinta del span original.
10. La redaccion se aplica con `PDF_REDACT_LINE_ART_NONE` para no borrar lineas vectoriales que cruzan el texto.

## Fidelidad de fuentes embebidas

Muchos PDFs no incluyen una fuente completa, sino un subset con solo los glifos usados en el documento. Por eso la app sigue este orden:

1. Reusar el recurso de fuente del PDF cuando la codificacion lo permite.
2. Si hay mapa `ToUnicode`, traducir caracteres Unicode a los codigos internos del subset y escribir un stream PDF propio.
3. Ajustar espaciado (`Tc`) para acercarse al ancho original sin deformar glifos.
4. Para codigos numericos pequenos, replicar la combinacion de tamano y escala compacta que suelen traer los tickets.
5. Si el texto nuevo usa glifos ausentes del subset, resolver a una fuente local parecida.

Este flujo evita cuadros, letras faltantes y texto demasiado ancho. La fidelidad maxima se obtiene cuando el texto nuevo usa caracteres que ya existen en el subset original.

## Calibracion de negrita

Muchos PDFs bancarios no usan una fuente Bold real. A veces el texto parece en negrita aunque la fuente se llame `ArialMT` normal. Por eso la app no depende solo del nombre de la fuente.

La app mide la densidad de tinta del texto original y, al exportar, prueba variantes de trazo muy finas hasta encontrar una densidad visual cercana. Esto ayuda a que textos como titulos o labels mantengan el peso aparente del PDF original.

## Almacenamiento runtime

Los PDFs cargados se guardan temporalmente en:

```text
.pdf_editor_storage/
```

Esa carpeta es runtime local y esta ignorada por git. Puede borrarse sin afectar el codigo; se recrea automaticamente cuando el backend recibe un PDF.

## Limitaciones conocidas

- Un PDF no guarda texto como un documento Word; guarda comandos de dibujo. Por eso la app reconstruye ediciones con redaccion + reinsercion.
- La deteccion perfecta de fuente depende de que el PDF incluya o permita extraer la fuente original.
- Si una fuente embebida es subset y el usuario escribe letras que no existen en ese subset, el backend debe usar una fuente fallback parecida.
- Si un texto esta dividido en varios spans, cada span se edita como box independiente.
- PDFs escaneados como imagen no tienen texto editable hasta que se agregue OCR.
- Algunos efectos avanzados del PDF original, como transformaciones raras, kerning muy especifico o texto en paths, pueden requerir mas heuristicas.

## Mantenimiento recomendado

- Ejecutar `npm run build` despues de cambios frontend.
- Ejecutar `python -m py_compile server\app.py` despues de cambios backend.
- No versionar `.pdf_editor_storage/`.
- No dejar servidores corriendo si solo se esta entregando codigo al usuario.
- Antes de tocar la calibracion de texto, probar con PDFs reales y comparar densidad objetivo vs densidad exportada.
