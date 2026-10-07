// Persist layout and bindings only. Actual Core work status is always read live.
export const boardKey = 'openaura.infinite-canvas.board.v1'
export const statuses = ['idle', 'running', 'completed', 'failed', 'unknown', 'interrupted']
const finite = (value, fallback = 0) => Number.isFinite(value) ? Math.max(-1e6, Math.min(1e6, value)) : fallback
export const clampZoom = value => Math.max(.25, Math.min(3, finite(value, 1)))
export const emptyBoard = () => ({ schemaVersion: 1, cards: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })

export function restoreBoard(raw) {
  const board = emptyBoard()
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.cards) || !Array.isArray(raw.edges)) return board
  const ids = new Set()
  for (const item of raw.cards.slice(0, 1000)) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) continue
    ids.add(item.id)
    const card = { id: item.id, title: String(item.title ?? 'New card').slice(0, 500), x: finite(item.x), y: finite(item.y), previewStatus: statuses.includes(item.previewStatus) ? item.previewStatus : 'idle' }
    if (typeof item.work?.agent === 'string' && typeof item.work?.turnId === 'string') card.work = { agent: item.work.agent, turnId: item.work.turnId }
    board.cards.push(card)
  }
  const edgeIds = new Set(), pairs = new Set()
  for (const item of raw.edges.slice(0, 4000)) {
    if (!item || typeof item.id !== 'string' || edgeIds.has(item.id) || !ids.has(item.source) || !ids.has(item.target) || item.source === item.target) continue
    const pair = JSON.stringify([item.source, item.target])
    if (pairs.has(pair)) continue
    edgeIds.add(item.id); pairs.add(pair)
    board.edges.push({ id: item.id, source: item.source, target: item.target, sourceSide: item.sourceSide === 'left' ? 'left' : 'right', targetSide: item.targetSide === 'right' ? 'right' : 'left' })
  }
  board.viewport = { x: finite(raw.viewport?.x), y: finite(raw.viewport?.y), zoom: clampZoom(raw.viewport?.zoom ?? 1) }
  return board
}

export function toWorld(point, viewport) {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom }
}

export function zoomAt(viewport, point, zoom) {
  const world = toWorld(point, viewport), next = clampZoom(zoom)
  return { x: point.x - world.x * next, y: point.y - world.y * next, zoom: next }
}

export function connectionCurve(a, b, sourceSide = 'right', targetSide = 'left') {
  const reach = Math.max(45, Math.min(240, Math.hypot(b.x - a.x, b.y - a.y) * .45))
  const c1 = { x: a.x + (sourceSide === 'left' ? -reach : reach), y: a.y }
  const c2 = { x: b.x + (targetSide === 'right' ? reach : -reach), y: b.y }
  return { a, b, c1, c2, d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}` }
}

export function connect(board, source, target, sourceSide = 'right', targetSide = 'left', id = crypto.randomUUID()) {
  if (source === target || !board.cards.some(c => c.id === source) || !board.cards.some(c => c.id === target)) return false
  if (board.edges.some(e => e.source === source && e.target === target)) return false
  board.edges.push({ id, source, target, sourceSide, targetSide })
  return true
}

export function workView(card, items, available, native) {
  if (!native) return { status: card.previewStatus || 'idle', label: 'Preview', activity: 'Simulated appearance; no task is running from this control.' }
  if (!card.work) return { status: 'idle', label: 'Local card', activity: 'Choose a Core task to display its actual status.' }
  if (!available) return { status: 'unknown', label: 'Core unavailable', activity: 'Live status could not be read. Retrying automatically.' }
  const item = items.find(w => w.agent === card.work.agent && w.turnId === card.work.turnId)
  if (!item) return { status: 'unknown', label: 'Core task unavailable', activity: 'This task is no longer present in the process-local Core log.' }
  return { status: statuses.includes(item.status) ? item.status : 'unknown', label: 'Core', activity: String(item.activity || '') }
}
