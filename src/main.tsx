import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Download,
  Eraser,
  FileUp,
  Highlighter,
  ImagePlus,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Save,
  Square,
  Trash2,
  Type,
} from 'lucide-react'
import './style.css'

type Rect = {
  x0: number
  y0: number
  x1: number
  y1: number
}

type Point = {
  x: number
  y: number
}

type TextSpan = {
  id: string
  text: string
  rect: Rect
  origin: Point
  fontFamily: string
  fontSize: number
  fontXref?: number | null
  fontResource?: string | null
  fontType?: string | null
  fontInkDensity?: number | null
  color: string
  flags: number
}

type ImageBox = {
  id: string
  rect: Rect
  xref: number
  width?: number
  height?: number
}

type DrawingBox = {
  id: string
  rect: Rect
  stroke?: string
  fill?: string
  width?: number
  type?: string
}

type PageInfo = {
  index: number
  width: number
  height: number
  rotation: number
  text: TextSpan[]
  images: ImageBox[]
  drawings: DrawingBox[]
}

type PdfDocument = {
  id: string
  filename: string
  pageCount: number
  pages: PageInfo[]
}

type Tool = 'select' | 'text' | 'rectangle' | 'highlight' | 'redact' | 'image'

type TextEdit = {
  span: TextSpan
  text: string
  rect: Rect
  origin: Point
  fontFamily: string
  fontSize: number
  fontFlags: number
  fontXref?: number | null
  fontResource?: string | null
  fontInkDensity?: number | null
  color: string
  deleted?: boolean
}

type ImageEdit = {
  image: ImageBox
  rect: Rect
  deleted?: boolean
}

type EditorOperation = {
  id: string
  type:
    | 'replace_text'
    | 'delete_text'
    | 'add_text'
    | 'rectangle'
    | 'highlight'
    | 'redact_area'
    | 'add_image'
    | 'move_image'
    | 'delete_image'
  pageIndex: number
  rect: Rect
  originalRect?: Rect
  spanId?: string
  objectId?: string
  text?: string
  fontFamily?: string
  fontSize?: number
  fontFlags?: number
  fontXref?: number | null
  fontResource?: string | null
  fontInkDensity?: number | null
  color?: string
  fill?: string
  opacity?: number
  strokeWidth?: number
  imageData?: string
  imageXref?: number
  origin?: Point
}

type Selection =
  | { kind: 'text'; id: string }
  | { kind: 'image'; id: string }
  | { kind: 'operation'; id: string }
  | { kind: 'drawing'; id: string }
  | null

type ResizeHandle = 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'se' | 'sw'

type PendingImage = {
  dataUrl: string
  width: number
  height: number
}

type DragState =
  | {
      kind: 'text' | 'image' | 'operation'
      id: string
      pageIndex: number
      startClient: Point
      startRect: Rect
      startOrigin?: Point
    }
  | {
      kind: 'draw'
      tool: Extract<Tool, 'rectangle' | 'highlight' | 'redact'>
      pageIndex: number
      start: Point
      current: Point
    }
  | {
      kind: 'resize'
      target: 'text' | 'image' | 'operation'
      id: string
      pageIndex: number
      startClient: Point
      startRect: Rect
      handle: ResizeHandle
      startOrigin?: Point
    }
  | null

const API_PROXY = '/api'
const API_DIRECT = 'http://127.0.0.1:8000/api'
const resizeHandles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const tools: Array<{ id: Tool; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'select', label: 'Seleccionar', icon: MousePointer2 },
  { id: 'text', label: 'Texto', icon: Type },
  { id: 'rectangle', label: 'Cuadro', icon: Square },
  { id: 'highlight', label: 'Resaltar', icon: Highlighter },
  { id: 'redact', label: 'Redactar', icon: Eraser },
  { id: 'image', label: 'Imagen', icon: ImagePlus },
]

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

function width(rect: Rect) {
  return rect.x1 - rect.x0
}

function height(rect: Rect) {
  return rect.y1 - rect.y0
}

function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return { x0: rect.x0 + dx, y0: rect.y0 + dy, x1: rect.x1 + dx, y1: rect.y1 + dy }
}

function normalizeRect(a: Point, b: Point): Rect {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  }
}

function clampRect(rect: Rect, page: PageInfo): Rect {
  const w = width(rect)
  const h = height(rect)
  const x0 = Math.max(0, Math.min(page.width - w, rect.x0))
  const y0 = Math.max(0, Math.min(page.height - h, rect.y0))
  return { x0, y0, x1: x0 + w, y1: y0 + h }
}

function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function rectStyle(rect: Rect, zoom: number): React.CSSProperties {
  return {
    left: `${rect.x0 * zoom}px`,
    top: `${rect.y0 * zoom}px`,
    width: `${Math.max(1, width(rect) * zoom)}px`,
    height: `${Math.max(1, height(rect) * zoom)}px`,
  }
}

function pointFromEvent(event: React.PointerEvent<HTMLElement>, pageElement: HTMLElement, zoom: number): Point {
  const bounds = pageElement.getBoundingClientRect()
  return {
    x: (event.clientX - bounds.left) / zoom,
    y: (event.clientY - bounds.top) / zoom,
  }
}

function inflate(rect: Rect, value: number): Rect {
  return { x0: rect.x0 - value, y0: rect.y0 - value, x1: rect.x1 + value, y1: rect.y1 + value }
}

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const dataUrl = String(reader.result)
      const image = new Image()
      image.onload = () => resolve({ dataUrl, width: image.naturalWidth || 240, height: image.naturalHeight || 160 })
      image.onerror = () => resolve({ dataUrl, width: 240, height: 160 })
      image.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}

function measureInlineTextWidth(edit: TextEdit, value: string, zoom: number) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) {
    return Math.max(width(edit.span.rect), value.length * edit.fontSize * 0.62)
  }
  const fontStyle = previewFontStyle(edit.fontFamily, edit.fontFlags)
  const fontWeight = previewFontWeight(edit.fontFamily, edit.fontFlags, edit.fontInkDensity)
  context.font = `${fontStyle} ${fontWeight} ${edit.fontSize * zoom}px ${previewFontFamily(edit.fontFamily)}`
  return context.measureText(value || ' ').width / zoom + 12
}

function isPdfFile(file: File) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

function findPdfFile(files: FileList | null | undefined) {
  return Array.from(files ?? []).find(isPdfFile) ?? null
}

function normalizedFontName(name: string | undefined) {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function previewFontFamily(name: string | undefined) {
  const key = normalizedFontName(name)
  if (key.includes('courier') || key.includes('mono')) {
    return '"Courier New", Consolas, monospace'
  }
  if (key.includes('times') || key.includes('roman') || key.includes('serif')) {
    return '"Times New Roman", Times, serif'
  }
  if (key.includes('calibri')) {
    return 'Calibri, Arial, sans-serif'
  }
  if (key.includes('arial') || key.includes('helvetica')) {
    return 'Arial, Helvetica, sans-serif'
  }
  return `${name ?? 'Arial'}, Arial, sans-serif`
}

function previewFontWeight(name: string | undefined, flags = 0, density?: number | null) {
  const key = normalizedFontName(name)
  if (flags & 16 || key.includes('bold') || key.includes('black') || key.includes('heavy') || key.endsWith('bd')) {
    return 800
  }
  if (key.includes('semibold') || key.includes('demibold') || key.includes('medium')) {
    return 650
  }
  if ((density ?? 0) >= 0.265) {
    return 700
  }
  if ((density ?? 0) >= 0.225) {
    return 650
  }
  return 400
}

function previewFontStyle(name: string | undefined, flags = 0) {
  const key = normalizedFontName(name)
  return flags & 2 || key.includes('italic') || key.includes('oblique') ? 'italic' : 'normal'
}

function textRenderStyle(
  fontFamily: string | undefined,
  fontSize: number | undefined,
  flags: number | undefined,
  color: string | undefined,
  zoom: number,
  density?: number | null,
): React.CSSProperties {
  return {
    color,
    fontFamily: previewFontFamily(fontFamily),
    fontSize: `${(fontSize ?? 11) * zoom}px`,
    fontStyle: previewFontStyle(fontFamily, flags),
    fontWeight: previewFontWeight(fontFamily, flags, density),
  }
}

function makeFormData(file: File) {
  const body = new FormData()
  body.append('file', file)
  return body
}

function App() {
  const [documentInfo, setDocumentInfo] = useState<PdfDocument | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<Selection>(null)
  const [textEdits, setTextEdits] = useState<Record<string, TextEdit>>({})
  const [imageEdits, setImageEdits] = useState<Record<string, ImageEdit>>({})
  const [operations, setOperations] = useState<EditorOperation[]>([])
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null)
  const [apiBase, setApiBase] = useState(API_PROXY)
  const [previewImages, setPreviewImages] = useState<Record<number, string>>({})
  const [drag, setDrag] = useState<DragState>(null)
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null)
  const [isDraggingPdf, setIsDraggingPdf] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Listo')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const inlineEditorRef = useRef<HTMLInputElement>(null)
  const fileDragDepthRef = useRef(0)

  const selectedText = selected?.kind === 'text' ? textEdits[selected.id] : null
  const selectedOperation =
    selected?.kind === 'operation' ? operations.find((operation) => operation.id === selected.id) ?? null : null
  const selectedImage = selected?.kind === 'image' ? imageEdits[selected.id] : null

  const totalEdits = useMemo(
    () =>
      Object.keys(textEdits).length +
      Object.keys(imageEdits).length +
      operations.length,
    [imageEdits, operations.length, textEdits],
  )

  useEffect(() => {
    if (!inlineEditingId || !inlineEditorRef.current) {
      return
    }
    inlineEditorRef.current.focus()
    inlineEditorRef.current.select()
  }, [inlineEditingId])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (inlineEditingId || tool !== 'select') {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return
      }
      const arrowDelta: Record<string, Point> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      }
      const delta = arrowDelta[event.key]
      if (!delta) {
        return
      }
      const step = event.shiftKey ? 10 : event.altKey ? 0.25 : 1
      const handled =
        event.ctrlKey || event.metaKey
          ? resizeSelectedBy(delta.x * step, delta.y * step)
          : moveSelectedBy(delta.x * step, delta.y * step)
      if (handled) {
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [documentInfo, inlineEditingId, selected, selectedImage, selectedOperation, selectedText, tool])

  useEffect(() => {
    if (!documentInfo) {
      setPreviewImages((current) => {
        Object.values(current).forEach(URL.revokeObjectURL)
        return {}
      })
      return
    }

    const timer = window.setTimeout(() => {
      const currentOperations = buildOperations()
      if (!currentOperations.length) {
        setPreviewImages((current) => {
          Object.values(current).forEach(URL.revokeObjectURL)
          return {}
        })
        return
      }

      const editedPages = Array.from(new Set(currentOperations.map((operation) => operation.pageIndex)))
      void Promise.all(
        editedPages.map(async (pageIndex) => {
          const response = await fetch(`${apiBase}/documents/${documentInfo.id}/pages/${pageIndex}/preview?scale=2`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operations: currentOperations }),
          })
          if (!response.ok) {
            throw new Error(`Preview ${pageIndex} failed`)
          }
          return [pageIndex, URL.createObjectURL(await response.blob())] as const
        }),
      )
        .then((entries) => {
          setPreviewImages((current) => {
            Object.values(current).forEach(URL.revokeObjectURL)
            return Object.fromEntries(entries)
          })
        })
        .catch(() => {
          setMessage('Vista previa no disponible; exportacion sigue activa')
        })
    }, 350)

    return () => window.clearTimeout(timer)
  }, [apiBase, documentInfo, imageEdits, operations, textEdits])

  async function uploadPdf(file: File) {
    setBusy(true)
    setMessage(`Analizando ${file.name}`)
    try {
      let usedApiBase = apiBase
      let response = await fetch(`${usedApiBase}/documents`, { method: 'POST', body: makeFormData(file) })

      if (!response.ok && usedApiBase === API_PROXY && (response.status === 404 || response.status === 502)) {
        usedApiBase = API_DIRECT
        response = await fetch(`${usedApiBase}/documents`, { method: 'POST', body: makeFormData(file) })
      }

      if (!response.ok) {
        const detail = await response.json().catch(() => null)
        if (response.status === 404 || response.status === 502) {
          throw new Error('API desconectada. Arranca con: npm run dev:all')
        }
        throw new Error(detail?.detail ?? `No se pudo cargar el PDF (${response.status})`)
      }
      const payload = (await response.json()) as PdfDocument
      setApiBase(usedApiBase)
      setDocumentInfo(payload)
      setSelected(null)
      setTextEdits({})
      setImageEdits({})
      setOperations([])
      setPreviewImages((current) => {
        Object.values(current).forEach(URL.revokeObjectURL)
        return {}
      })
      setMessage(`${payload.pageCount} paginas, ${payload.pages.reduce((sum, page) => sum + page.text.length, 0)} textos`)
    } catch (error) {
      if (error instanceof TypeError) {
        if (apiBase === API_PROXY) {
          try {
            const response = await fetch(`${API_DIRECT}/documents`, { method: 'POST', body: makeFormData(file) })
            if (response.ok) {
              const payload = (await response.json()) as PdfDocument
              setApiBase(API_DIRECT)
              setDocumentInfo(payload)
              setSelected(null)
              setTextEdits({})
              setImageEdits({})
              setOperations([])
              setPreviewImages((current) => {
                Object.values(current).forEach(URL.revokeObjectURL)
                return {}
              })
              setMessage(`${payload.pageCount} paginas, ${payload.pages.reduce((sum, page) => sum + page.text.length, 0)} textos`)
              return
            }
          } catch {
            setMessage('API desconectada. Arranca con: npm run dev:all')
            return
          }
        }
        setMessage('API desconectada. Arranca con: npm run dev:all')
      } else {
        setMessage(error instanceof Error ? error.message : 'Error al cargar')
      }
    } finally {
      setBusy(false)
    }
  }

  function openPdfFile(file: File | null | undefined) {
    if (!file) {
      return
    }
    if (!isPdfFile(file)) {
      setMessage('Selecciona un archivo PDF')
      return
    }
    void uploadPdf(file)
  }

  function hasDraggedFiles(event: React.DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes('Files')
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return
    }
    event.preventDefault()
    fileDragDepthRef.current += 1
    setIsDraggingPdf(true)
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return
    }
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1)
    if (fileDragDepthRef.current === 0) {
      setIsDraggingPdf(false)
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) {
      return
    }
    event.preventDefault()
    fileDragDepthRef.current = 0
    setIsDraggingPdf(false)
    openPdfFile(findPdfFile(event.dataTransfer.files) ?? event.dataTransfer.files[0])
  }

  function getTextEdit(span: TextSpan): TextEdit {
    return (
      textEdits[span.id] ?? {
        span,
        text: span.text,
        rect: span.rect,
        origin: span.origin,
        fontFamily: span.fontFamily,
        fontSize: span.fontSize,
        fontFlags: span.flags,
        fontXref: span.fontXref,
        fontResource: span.fontResource,
        fontInkDensity: span.fontInkDensity,
        color: span.color,
      }
    )
  }

  function commitTextEdit(edit: TextEdit) {
    setTextEdits((current) => ({ ...current, [edit.span.id]: edit }))
  }

  function selectText(span: TextSpan) {
    commitTextEdit(getTextEdit(span))
    setSelected({ kind: 'text', id: span.id })
    setTool('select')
  }

  function beginInlineTextEdit(span: TextSpan, _page?: PageInfo) {
    const edit = getTextEdit(span)
    commitTextEdit(edit)
    setSelected({ kind: 'text', id: span.id })
    setInlineEditingId(span.id)
    setTool('select')
  }

  function getImageEdit(image: ImageBox): ImageEdit {
    return imageEdits[image.id] ?? { image, rect: image.rect }
  }

  function commitImageEdit(edit: ImageEdit) {
    setImageEdits((current) => ({ ...current, [edit.image.id]: edit }))
  }

  function revertTextEdit(id: string) {
    setTextEdits((current) => {
      const { [id]: _removed, ...rest } = current
      return rest
    })
    if (selected?.kind === 'text' && selected.id === id) {
      setSelected(null)
    }
    if (inlineEditingId === id) {
      setInlineEditingId(null)
    }
  }

  function revertImageEdit(id: string) {
    setImageEdits((current) => {
      const { [id]: _removed, ...rest } = current
      return rest
    })
    if (selected?.kind === 'image' && selected.id === id) {
      setSelected(null)
    }
  }

  function revertOperation(id: string) {
    setOperations((current) => current.filter((operation) => operation.id !== id))
    if (selected?.kind === 'operation' && selected.id === id) {
      setSelected(null)
    }
  }

  function stopOverlayAction(event: React.MouseEvent | React.PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
  }

  function startMove(event: React.PointerEvent<HTMLElement>, kind: 'text' | 'image' | 'operation', id: string, page: PageInfo) {
    if (tool !== 'select') {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const edit =
      kind === 'text'
        ? textEdits[id]
        : kind === 'image'
          ? imageEdits[id]
          : operations.find((operation) => operation.id === id)
    if (!edit) {
      return
    }
    const startRect = edit.rect
    const startOrigin = kind === 'text' ? (edit as TextEdit).origin : undefined
    setDrag({
      kind,
      id,
      pageIndex: page.index,
      startClient: { x: event.clientX, y: event.clientY },
      startRect,
      startOrigin,
    })
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function startResize(
    event: React.PointerEvent<HTMLElement>,
    target: 'text' | 'image' | 'operation',
    id: string,
    page: PageInfo,
    startRect: Rect,
    handle: ResizeHandle,
  ) {
    event.preventDefault()
    event.stopPropagation()
    const startOrigin = target === 'text' ? textEdits[id]?.origin : undefined
    setDrag({
      kind: 'resize',
      target,
      id,
      pageIndex: page.index,
      startClient: { x: event.clientX, y: event.clientY },
      startRect,
      handle,
      startOrigin,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resizeRect(startRect: Rect, dx: number, dy: number, page: PageInfo, handle: ResizeHandle): Rect {
    const minWidth = 4
    const minHeight = 4
    const rect = { ...startRect }
    if (handle.includes('w')) {
      rect.x0 = clampValue(startRect.x0 + dx, 0, startRect.x1 - minWidth)
    }
    if (handle.includes('e')) {
      rect.x1 = clampValue(startRect.x1 + dx, startRect.x0 + minWidth, page.width)
    }
    if (handle.includes('n')) {
      rect.y0 = clampValue(startRect.y0 + dy, 0, startRect.y1 - minHeight)
    }
    if (handle.includes('s')) {
      rect.y1 = clampValue(startRect.y1 + dy, startRect.y0 + minHeight, page.height)
    }
    return rect
  }

  function updateSelectionText(patch: Partial<TextEdit>) {
    if (!selectedText) {
      return
    }
    commitTextEdit({ ...selectedText, ...patch })
  }

  function fitInlineTextRect(edit: TextEdit, value: string, page: PageInfo): Rect {
    const singleLineValue = value.replace(/[\r\n]+/g, ' ')
    const measuredWidth = measureInlineTextWidth(edit, singleLineValue, zoom)
    const nextWidth = Math.max(width(edit.span.rect), width(edit.rect), measuredWidth)
    return {
      ...edit.rect,
      x1: Math.min(page.width, edit.rect.x0 + nextWidth),
    }
  }

  function updateInlineText(edit: TextEdit, value: string, page: PageInfo) {
    const singleLineValue = value.replace(/[\r\n]+/g, ' ')
    commitTextEdit({
      ...edit,
      text: singleLineValue,
      rect: fitInlineTextRect(edit, singleLineValue, page),
    })
  }

  function updateSelectedOperation(patch: Partial<EditorOperation>) {
    if (!selectedOperation) {
      return
    }
    setOperations((current) =>
      current.map((operation) => (operation.id === selectedOperation.id ? { ...operation, ...patch } : operation)),
    )
  }

  function pageForSelection() {
    if (!documentInfo || !selected) {
      return null
    }
    if (selected.kind === 'operation' && selectedOperation) {
      return documentInfo.pages[selectedOperation.pageIndex] ?? null
    }
    if (selected.kind === 'text') {
      return documentInfo.pages.find((page) => page.text.some((span) => span.id === selected.id)) ?? null
    }
    if (selected.kind === 'image') {
      return documentInfo.pages.find((page) => page.images.some((image) => image.id === selected.id)) ?? null
    }
    return null
  }

  function moveSelectedBy(dx: number, dy: number) {
    const page = pageForSelection()
    if (!page || !selected) {
      return false
    }
    if (selected.kind === 'text' && selectedText) {
      const rect = clampRect(moveRect(selectedText.rect, dx, dy), page)
      const originDx = rect.x0 - selectedText.rect.x0
      const originDy = rect.y0 - selectedText.rect.y0
      commitTextEdit({
        ...selectedText,
        rect,
        origin: { x: selectedText.origin.x + originDx, y: selectedText.origin.y + originDy },
      })
      return true
    }
    if (selected.kind === 'image' && selectedImage) {
      commitImageEdit({ ...selectedImage, rect: clampRect(moveRect(selectedImage.rect, dx, dy), page) })
      return true
    }
    if (selected.kind === 'operation' && selectedOperation) {
      const rect = clampRect(moveRect(selectedOperation.rect, dx, dy), page)
      updateSelectedOperation({ rect })
      return true
    }
    return false
  }

  function resizeSelectedBy(dx: number, dy: number) {
    const page = pageForSelection()
    if (!page || !selected) {
      return false
    }
    if (selected.kind === 'text' && selectedText) {
      commitTextEdit({ ...selectedText, rect: resizeRect(selectedText.rect, dx, dy, page, 'se') })
      return true
    }
    if (selected.kind === 'image' && selectedImage) {
      commitImageEdit({ ...selectedImage, rect: resizeRect(selectedImage.rect, dx, dy, page, 'se') })
      return true
    }
    if (selected.kind === 'operation' && selectedOperation) {
      updateSelectedOperation({ rect: resizeRect(selectedOperation.rect, dx, dy, page, 'se') })
      return true
    }
    return false
  }

  function deleteSelected() {
    if (selected?.kind === 'text' && selectedText) {
      commitTextEdit({ ...selectedText, deleted: true })
      setInlineEditingId(null)
      return
    }
    if (selected?.kind === 'image' && selectedImage) {
      commitImageEdit({ ...selectedImage, deleted: true })
      return
    }
    if (selected?.kind === 'operation') {
      setOperations((current) => current.filter((operation) => operation.id !== selected.id))
      setSelected(null)
    }
  }

  function resetAll() {
    setTextEdits({})
    setImageEdits({})
    setOperations([])
    setPreviewImages((current) => {
      Object.values(current).forEach(URL.revokeObjectURL)
      return {}
    })
    setSelected(null)
    setMessage('Cambios reiniciados')
  }

  function pagePointerDown(event: React.PointerEvent<HTMLDivElement>, page: PageInfo) {
    if (!documentInfo || event.target !== event.currentTarget) {
      return
    }
    const point = pointFromEvent(event, event.currentTarget, zoom)
    if (tool === 'text') {
      const rect = { x0: point.x, y0: point.y, x1: point.x + 220, y1: point.y + 44 }
      const operation: EditorOperation = {
        id: uid('text'),
        type: 'add_text',
        pageIndex: page.index,
        rect: clampRect(rect, page),
        text: 'Nuevo texto',
        fontFamily: 'Arial',
        fontSize: 14,
        color: '#111827',
      }
      setOperations((current) => [...current, operation])
      setSelected({ kind: 'operation', id: operation.id })
      setTool('select')
      return
    }
    if (tool === 'image' && pendingImage) {
      const maxWidth = Math.min(260, page.width * 0.45)
      const ratio = pendingImage.height / pendingImage.width
      const rect = { x0: point.x, y0: point.y, x1: point.x + maxWidth, y1: point.y + maxWidth * ratio }
      const operation: EditorOperation = {
        id: uid('image'),
        type: 'add_image',
        pageIndex: page.index,
        rect: clampRect(rect, page),
        imageData: pendingImage.dataUrl,
      }
      setOperations((current) => [...current, operation])
      setSelected({ kind: 'operation', id: operation.id })
      setTool('select')
      return
    }
    if (tool === 'rectangle' || tool === 'highlight' || tool === 'redact') {
      setDrag({ kind: 'draw', tool, pageIndex: page.index, start: point, current: point })
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    setSelected(null)
  }

  function pagePointerMove(event: React.PointerEvent<HTMLDivElement>, page: PageInfo) {
    if (!drag) {
      return
    }
    if (drag.kind === 'draw' && drag.pageIndex === page.index) {
      setDrag({ ...drag, current: pointFromEvent(event, event.currentTarget, zoom) })
      return
    }
    if (drag.kind === 'resize' && drag.pageIndex === page.index) {
      const dx = (event.clientX - drag.startClient.x) / zoom
      const dy = (event.clientY - drag.startClient.y) / zoom
      const rect = resizeRect(drag.startRect, dx, dy, page, drag.handle)
      if (drag.target === 'text') {
        const edit = textEdits[drag.id]
        if (edit) {
          const originDx = rect.x0 - drag.startRect.x0
          const originDy = rect.y0 - drag.startRect.y0
          commitTextEdit({
            ...edit,
            rect,
            origin: drag.startOrigin
              ? { x: drag.startOrigin.x + originDx, y: drag.startOrigin.y + originDy }
              : edit.origin,
          })
        }
      } else if (drag.target === 'image') {
        const edit = imageEdits[drag.id]
        if (edit) {
          commitImageEdit({ ...edit, rect })
        }
      } else {
        setOperations((current) =>
          current.map((operation) => (operation.id === drag.id ? { ...operation, rect } : operation)),
        )
      }
      return
    }
    if (drag.kind !== 'draw' && drag.kind !== 'resize' && drag.pageIndex === page.index) {
      const dx = (event.clientX - drag.startClient.x) / zoom
      const dy = (event.clientY - drag.startClient.y) / zoom
      const rect = clampRect(moveRect(drag.startRect, dx, dy), page)
      if (drag.kind === 'text') {
        const edit = textEdits[drag.id]
        if (edit) {
          commitTextEdit({
            ...edit,
            rect,
            origin: drag.startOrigin ? { x: drag.startOrigin.x + dx, y: drag.startOrigin.y + dy } : edit.origin,
          })
        }
      } else if (drag.kind === 'image') {
        const edit = imageEdits[drag.id]
        if (edit) {
          commitImageEdit({ ...edit, rect })
        }
      } else {
        setOperations((current) =>
          current.map((operation) => (operation.id === drag.id ? { ...operation, rect } : operation)),
        )
      }
    }
  }

  function pagePointerUp(event: React.PointerEvent<HTMLDivElement>, page: PageInfo) {
    if (!drag) {
      return
    }
    if (drag.kind === 'draw' && drag.pageIndex === page.index) {
      const rect = normalizeRect(drag.start, drag.current)
      if (width(rect) > 4 && height(rect) > 4) {
        const operation: EditorOperation = {
          id: uid(drag.tool),
          type: drag.tool === 'redact' ? 'redact_area' : drag.tool,
          pageIndex: page.index,
          rect,
          color: drag.tool === 'rectangle' ? '#2563eb' : '#facc15',
          fill: drag.tool === 'redact' ? '#111111' : drag.tool === 'highlight' ? '#fde047' : undefined,
          opacity: drag.tool === 'highlight' ? 0.35 : 1,
          strokeWidth: 1.2,
        }
        setOperations((current) => [...current, operation])
        setSelected({ kind: 'operation', id: operation.id })
      }
    }
    setDrag(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function buildOperations(): EditorOperation[] {
    const textOps = Object.values(textEdits)
      .filter((edit) => {
        if (edit.deleted) {
          return true
        }
        return (
          edit.text !== edit.span.text ||
          edit.fontFamily !== edit.span.fontFamily ||
          edit.fontSize !== edit.span.fontSize ||
          edit.color !== edit.span.color ||
          JSON.stringify(edit.rect) !== JSON.stringify(edit.span.rect)
        )
      })
      .map<EditorOperation>((edit) => ({
        id: `op-${edit.span.id}`,
        type: edit.deleted ? 'delete_text' : 'replace_text',
        pageIndex: Number(edit.span.id.split('-')[0].replace('p', '')),
        spanId: edit.span.id,
        rect: edit.rect,
        originalRect: inflate(edit.span.rect, 0.7),
        text: edit.text,
        fontFamily: edit.fontFamily,
        fontSize: edit.fontSize,
        fontFlags: edit.fontFlags,
        fontXref: edit.fontXref,
        fontResource: edit.fontResource,
        fontInkDensity: edit.fontInkDensity,
        color: edit.color,
        origin: edit.origin,
      }))

    const imageOps = Object.values(imageEdits)
      .filter((edit) => edit.deleted || JSON.stringify(edit.rect) !== JSON.stringify(edit.image.rect))
      .map<EditorOperation>((edit) => ({
        id: `op-${edit.image.id}`,
        type: edit.deleted ? 'delete_image' : 'move_image',
        pageIndex: Number(edit.image.id.split('-')[0].replace('p', '')),
        objectId: edit.image.id,
        rect: edit.rect,
        originalRect: edit.image.rect,
        imageXref: edit.image.xref,
      }))

    return [...textOps, ...imageOps, ...operations]
  }

  async function exportPdf() {
    if (!documentInfo) {
      return
    }
    setBusy(true)
    setMessage('Exportando PDF')
    try {
      const response = await fetch(`${apiBase}/documents/${documentInfo.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: buildOperations() }),
      })
      if (!response.ok) {
        throw new Error('No se pudo exportar')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `editado-${documentInfo.filename || 'documento.pdf'}`
      anchor.click()
      URL.revokeObjectURL(url)
      setMessage('PDF exportado')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Error al exportar')
    } finally {
      setBusy(false)
    }
  }

  function renderResizeHandles(
    target: 'text' | 'image' | 'operation',
    id: string,
    page: PageInfo,
    rect: Rect,
  ) {
    return resizeHandles.map((handle) => (
      <span
        className={`resize-handle resize-${handle}`}
        key={handle}
        title="Cambiar tamano"
        onPointerDown={(event) => startResize(event, target, id, page, rect, handle)}
      />
    ))
  }

  function renderPage(page: PageInfo) {
    const pageStyle: React.CSSProperties = {
      width: `${page.width * zoom}px`,
      height: `${page.height * zoom}px`,
    }
    const draft =
      drag?.kind === 'draw' && drag.pageIndex === page.index ? normalizeRect(drag.start, drag.current) : null

    return (
      <section className="page-shell" key={page.index}>
        <div className="page-meta">
          <span>Pagina {page.index + 1}</span>
          <span>
            {page.text.length} textos / {page.images.length} imagenes
          </span>
        </div>
        <div
          className="pdf-page"
          style={pageStyle}
          onPointerDown={(event) => pagePointerDown(event, page)}
          onPointerMove={(event) => pagePointerMove(event, page)}
          onPointerUp={(event) => pagePointerUp(event, page)}
        >
          <img
            className="page-bitmap"
            src={previewImages[page.index] ?? `${apiBase}/documents/${documentInfo?.id}/pages/${page.index}/image?scale=2`}
            alt={`Pagina ${page.index + 1}`}
            draggable={false}
          />
          {page.drawings.map((drawing) => (
            <button
              className={`drawing-box ${selected?.kind === 'drawing' && selected.id === drawing.id ? 'is-selected' : ''}`}
              key={drawing.id}
              style={rectStyle(drawing.rect, zoom)}
              onClick={(event) => {
                event.stopPropagation()
                setSelected({ kind: 'drawing', id: drawing.id })
              }}
              title="Vector"
            />
          ))}
          {page.images.map((image) => {
            const edit = getImageEdit(image)
            const selectedImageBox = selected?.kind === 'image' && selected.id === image.id
            const imageChanged = edit.deleted || JSON.stringify(edit.rect) !== JSON.stringify(image.rect)
            return (
              <div
                role="button"
                tabIndex={0}
                className={`image-box ${selectedImageBox ? 'is-selected' : ''} ${imageChanged ? 'is-changed' : ''} ${edit.deleted ? 'is-deleted' : ''}`}
                key={image.id}
                style={rectStyle(edit.rect, zoom)}
                onClick={(event) => {
                  event.stopPropagation()
                  commitImageEdit(edit)
                  setSelected({ kind: 'image', id: image.id })
                  setTool('select')
                }}
                onPointerDown={(event) => {
                  commitImageEdit(edit)
                  startMove(event, 'image', image.id, page)
                }}
                title="Imagen"
              >
                {imageChanged ? (
                  <button
                    className="revert-edit-button"
                    title="Revertir cambio"
                    onPointerDown={stopOverlayAction}
                    onClick={(event) => {
                      stopOverlayAction(event)
                      revertImageEdit(image.id)
                    }}
                  >
                    <RotateCcw size={12} />
                  </button>
                ) : null}
                {selectedImageBox ? renderResizeHandles('image', image.id, page, edit.rect) : null}
              </div>
            )
          })}
          {page.text.map((span) => {
            const edit = getTextEdit(span)
            const selectedSpan = selected?.kind === 'text' && selected.id === span.id
            const inlineEditing = inlineEditingId === span.id && !edit.deleted
            const displayRect = inlineEditing ? fitInlineTextRect(edit, edit.text, page) : edit.rect
            const changed =
              edit.deleted ||
              edit.text !== span.text ||
              edit.fontFamily !== span.fontFamily ||
              edit.fontSize !== span.fontSize ||
              edit.color !== span.color ||
              JSON.stringify(edit.rect) !== JSON.stringify(span.rect)
            return (
              <div
                role="button"
                tabIndex={0}
                className={`text-box ${selectedSpan ? 'is-selected' : ''} ${changed ? 'is-changed' : ''} ${edit.deleted ? 'is-deleted' : ''}`}
                key={span.id}
                style={rectStyle(displayRect, zoom)}
                onClick={(event) => {
                  event.stopPropagation()
                  selectText(span)
                }}
                onDoubleClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  beginInlineTextEdit(span, page)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    beginInlineTextEdit(span, page)
                  }
                }}
                onPointerDown={(event) => {
                  if (inlineEditingId === span.id) {
                    return
                  }
                  commitTextEdit(edit)
                  startMove(event, 'text', span.id, page)
                }}
                title={`${span.fontFamily} ${span.fontSize}px`}
              >
                {inlineEditing ? (
                  <input
                    ref={inlineEditorRef}
                    type="text"
                    spellCheck={false}
                    className="inline-text-editor"
                    value={edit.text}
                    style={{
                      ...textRenderStyle(
                        edit.fontFamily,
                        edit.fontSize,
                        edit.fontFlags,
                        edit.color,
                        zoom,
                        edit.fontInkDensity,
                      ),
                    }}
                    onChange={(event) => updateInlineText(edit, event.target.value, page)}
                    onBlur={() => setInlineEditingId(null)}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        commitTextEdit({ ...edit, text: span.text })
                        setInlineEditingId(null)
                      }
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        setInlineEditingId(null)
                      }
                    }}
                  />
                ) : changed && !edit.deleted && !previewImages[page.index] ? (
                  <span
                    className="text-preview"
                    style={textRenderStyle(
                      edit.fontFamily,
                      edit.fontSize,
                      edit.fontFlags,
                      edit.color,
                      zoom,
                      edit.fontInkDensity,
                    )}
                  >
                    {edit.text}
                  </span>
                ) : null}
                {changed ? (
                  <button
                    className="revert-edit-button"
                    title="Revertir cambio"
                    onPointerDown={stopOverlayAction}
                    onClick={(event) => {
                      stopOverlayAction(event)
                      revertTextEdit(span.id)
                    }}
                  >
                    <RotateCcw size={12} />
                  </button>
                ) : null}
                {!inlineEditing && selectedSpan ? renderResizeHandles('text', span.id, page, edit.rect) : null}
              </div>
            )
          })}
          {operations
            .filter((operation) => operation.pageIndex === page.index)
            .map((operation) => {
              const selectedOperationBox = selected?.kind === 'operation' && selected.id === operation.id
              return (
                <div
                  role="button"
                  tabIndex={0}
                  className={`operation-box op-${operation.type} ${selectedOperationBox ? 'is-selected' : ''}`}
                  key={operation.id}
                  style={rectStyle(operation.rect, zoom)}
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelected({ kind: 'operation', id: operation.id })
                  }}
                  onPointerDown={(event) => startMove(event, 'operation', operation.id, page)}
                  title={operation.type}
                >
                  {operation.type === 'add_text' && !previewImages[page.index] ? (
                    <span
                      className="text-preview"
                      style={{
                        ...textRenderStyle(
                          operation.fontFamily,
                          operation.fontSize,
                          operation.fontFlags,
                          operation.color,
                          zoom,
                          operation.fontInkDensity,
                        ),
                      }}
                    >
                      {operation.text}
                    </span>
                  ) : operation.type === 'add_image' && operation.imageData && !previewImages[page.index] ? (
                    <img src={operation.imageData} alt="" />
                  ) : null}
                  <button
                    className="revert-edit-button"
                    title="Revertir cambio"
                    onPointerDown={stopOverlayAction}
                    onClick={(event) => {
                      stopOverlayAction(event)
                      revertOperation(operation.id)
                    }}
                  >
                    <RotateCcw size={12} />
                  </button>
                  {selectedOperationBox ? renderResizeHandles('operation', operation.id, page, operation.rect) : null}
                </div>
              )
            })}
          {draft ? (
            <div
              className={`draft-box draft-${drag?.kind === 'draw' ? drag.tool : 'rectangle'}`}
              style={rectStyle(draft, zoom)}
            />
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <div
      className={`app ${isDraggingPdf ? 'is-file-hover' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingPdf ? (
        <div className="drop-overlay">
          <FileUp size={34} />
          <strong>Suelta el PDF</strong>
        </div>
      ) : null}
      <header className="topbar">
        <div className="brand">
          <Save size={20} />
          <div>
            <strong>Editor PDF</strong>
            <span>{documentInfo?.filename ?? 'Sin documento'}</span>
          </div>
        </div>
        <div className="toolbar" aria-label="Herramientas">
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="application/pdf"
            onChange={(event) => {
              openPdfFile(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
          <button className="tool-button command" onClick={() => fileInputRef.current?.click()} title="Abrir PDF">
            <FileUp size={18} />
            <span>Abrir</span>
          </button>
          <div className="tool-group">
            {tools.map((item) => {
              const Icon = item.icon
              return (
                <button
                  className={`tool-button ${tool === item.id ? 'is-active' : ''}`}
                  key={item.id}
                  onClick={() => setTool(item.id)}
                  title={item.label}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
          <input
            ref={imageInputRef}
            className="hidden-input"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                void readImage(file).then((image) => {
                  setPendingImage(image)
                  setTool('image')
                  setMessage('Imagen lista')
                })
              }
            }}
          />
          <button className="tool-button" onClick={() => imageInputRef.current?.click()} title="Cargar imagen">
            <ImagePlus size={18} />
          </button>
          <button className="tool-button" onClick={() => setZoom((value) => Math.max(0.45, value - 0.1))} title="Alejar">
            <Minus size={18} />
          </button>
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
          <button className="tool-button" onClick={() => setZoom((value) => Math.min(2.2, value + 0.1))} title="Acercar">
            <Plus size={18} />
          </button>
          <button className="tool-button" onClick={resetAll} disabled={!totalEdits} title="Reiniciar cambios">
            <RotateCcw size={18} />
          </button>
          <button className="tool-button command primary" onClick={exportPdf} disabled={!documentInfo || busy} title="Exportar PDF">
            <Download size={18} />
            <span>Exportar</span>
          </button>
        </div>
        <div className="status">{busy ? 'Trabajando' : message}</div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <div className="panel-title">Paginas</div>
          <div className="page-list">
            {documentInfo?.pages.map((page) => (
              <a className="page-link" href={`#page-${page.index}`} key={page.index}>
                <span>{page.index + 1}</span>
                <small>{Math.round(page.width)} x {Math.round(page.height)}</small>
              </a>
            )) ?? <div className="empty-state">Abre un PDF</div>}
          </div>
        </aside>

        <section className="canvas-area">
          {documentInfo ? (
            documentInfo.pages.map((page) => (
              <div id={`page-${page.index}`} key={page.index}>
                {renderPage(page)}
              </div>
            ))
          ) : (
            <div className="drop-zone" onClick={() => fileInputRef.current?.click()}>
              <FileUp size={36} />
              <strong>Abrir PDF</strong>
              <span>Arrastra el archivo aqui</span>
            </div>
          )}
        </section>

        <aside className="inspector">
          <div className="panel-title">Inspector</div>
          {selectedText ? (
            <div className="control-stack">
              <label>
                Texto
                <textarea value={selectedText.text} onChange={(event) => updateSelectionText({ text: event.target.value })} />
              </label>
              <label>
                Fuente
                <input value={selectedText.fontFamily} onChange={(event) => updateSelectionText({ fontFamily: event.target.value })} />
              </label>
              <label>
                Tamano
                <input
                  type="number"
                  min="4"
                  max="180"
                  step="0.5"
                  value={selectedText.fontSize}
                  onChange={(event) => updateSelectionText({ fontSize: Number(event.target.value) })}
                />
              </label>
              <label>
                Color
                <input type="color" value={selectedText.color} onChange={(event) => updateSelectionText({ color: event.target.value })} />
              </label>
              <div className="grid-two">
                <label>
                  X
                  <input
                    type="number"
                    value={Math.round(selectedText.rect.x0)}
                    onChange={(event) => {
                      const nextX = Number(event.target.value)
                      const dx = nextX - selectedText.rect.x0
                      updateSelectionText({
                        rect: moveRect(selectedText.rect, dx, 0),
                        origin: { x: selectedText.origin.x + dx, y: selectedText.origin.y },
                      })
                    }}
                  />
                </label>
                <label>
                  Y
                  <input
                    type="number"
                    value={Math.round(selectedText.rect.y0)}
                    onChange={(event) => {
                      const nextY = Number(event.target.value)
                      const dy = nextY - selectedText.rect.y0
                      updateSelectionText({
                        rect: moveRect(selectedText.rect, 0, dy),
                        origin: { x: selectedText.origin.x, y: selectedText.origin.y + dy },
                      })
                    }}
                  />
                </label>
              </div>
              <div className="grid-two">
                <label>
                  Ancho
                  <input
                    type="number"
                    min="8"
                    value={Math.round(width(selectedText.rect))}
                    onChange={(event) =>
                      updateSelectionText({
                        rect: { ...selectedText.rect, x1: selectedText.rect.x0 + Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  Alto
                  <input
                    type="number"
                    min="8"
                    value={Math.round(height(selectedText.rect))}
                    onChange={(event) =>
                      updateSelectionText({
                        rect: { ...selectedText.rect, y1: selectedText.rect.y0 + Number(event.target.value) },
                      })
                    }
                  />
                </label>
              </div>
              <button className="danger-button" onClick={deleteSelected}>
                <Trash2 size={16} />
                Eliminar texto
              </button>
            </div>
          ) : selectedImage ? (
            <div className="control-stack">
              <div className="object-summary">Imagen {selectedImage.image.xref || ''}</div>
              <div className="grid-two">
                <label>
                  Ancho
                  <input
                    type="number"
                    value={Math.round(width(selectedImage.rect))}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      commitImageEdit({ ...selectedImage, rect: { ...selectedImage.rect, x1: selectedImage.rect.x0 + next } })
                    }}
                  />
                </label>
                <label>
                  Alto
                  <input
                    type="number"
                    value={Math.round(height(selectedImage.rect))}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      commitImageEdit({ ...selectedImage, rect: { ...selectedImage.rect, y1: selectedImage.rect.y0 + next } })
                    }}
                  />
                </label>
              </div>
              <button className="danger-button" onClick={deleteSelected}>
                <Trash2 size={16} />
                Eliminar imagen
              </button>
            </div>
          ) : selectedOperation ? (
            <div className="control-stack">
              {selectedOperation.type === 'add_text' ? (
                <>
                  <label>
                    Texto
                    <textarea
                      value={selectedOperation.text}
                      onChange={(event) => updateSelectedOperation({ text: event.target.value })}
                    />
                  </label>
                  <label>
                    Fuente
                    <input
                      value={selectedOperation.fontFamily}
                      onChange={(event) => updateSelectedOperation({ fontFamily: event.target.value })}
                    />
                  </label>
                  <label>
                    Tamano
                    <input
                      type="number"
                      min="4"
                      max="180"
                      value={selectedOperation.fontSize}
                      onChange={(event) => updateSelectedOperation({ fontSize: Number(event.target.value) })}
                    />
                  </label>
                </>
              ) : null}
              {selectedOperation.type !== 'add_image' ? (
                <label>
                  Color
                  <input
                    type="color"
                    value={selectedOperation.fill ?? selectedOperation.color ?? '#2563eb'}
                    onChange={(event) =>
                      updateSelectedOperation({
                        color: selectedOperation.type === 'rectangle' ? event.target.value : selectedOperation.color,
                        fill: selectedOperation.type !== 'rectangle' ? event.target.value : selectedOperation.fill,
                      })
                    }
                  />
                </label>
              ) : null}
              <div className="grid-two">
                <label>
                  Ancho
                  <input
                    type="number"
                    value={Math.round(width(selectedOperation.rect))}
                    onChange={(event) =>
                      updateSelectedOperation({
                        rect: { ...selectedOperation.rect, x1: selectedOperation.rect.x0 + Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  Alto
                  <input
                    type="number"
                    value={Math.round(height(selectedOperation.rect))}
                    onChange={(event) =>
                      updateSelectedOperation({
                        rect: { ...selectedOperation.rect, y1: selectedOperation.rect.y0 + Number(event.target.value) },
                      })
                    }
                  />
                </label>
              </div>
              <button className="danger-button" onClick={deleteSelected}>
                <Trash2 size={16} />
                Eliminar
              </button>
            </div>
          ) : (
            <div className="empty-state">Selecciona un elemento</div>
          )}
        </aside>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
