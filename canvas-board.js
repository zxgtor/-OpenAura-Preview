import { boardKey, restoreBoard, emptyBoard, toWorld, zoomAt, connectionCurve, connect, workView } from './board-model.mjs'

const ns = 'http://www.w3.org/2000/svg'
const svgNode = (tag, attrs = {}) => { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node }
const button = (label, className, text) => Object.assign(document.createElement('button'), { type: 'button', className, title: label, textContent: text })

// Touch activation must not depend on the delayed/suppressed compatibility click
// after a canvas gesture. Mouse clicks and keyboard activation still use click.
export function onActivate(node, action) {
  let touch = null, lastTouch = -Infinity
  node.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') touch = { id: e.pointerId, x: e.clientX, y: e.clientY } })
  node.addEventListener('pointercancel', () => { touch = null })
  node.addEventListener('pointerup', e => {
    if (!touch || e.pointerId !== touch.id) return
    const tapped = Math.hypot(e.clientX - touch.x, e.clientY - touch.y) < 8
    touch = null
    if (tapped) { lastTouch = performance.now(); action(e) }
  })
  node.addEventListener('click', e => { if (e.detail && (e.pointerType === 'touch' || performance.now() - lastTouch < 500)) return; action(e) })
}

export function mountBoard(shell) {
  let model = emptyBoard(), saveTimer, noticeTimer, selected = null, pending = null, gesture = null, hand = false, suppressClick = false
  let workItems = [], workAvailable = false, pollTimer, pollBusy = false
  const invoke = window.__TAURI__?.core?.invoke, native = typeof invoke === 'function'
  const elements = new Map(), wires = new Map(), pointers = new Map()
  try { model = restoreBoard(JSON.parse(localStorage.getItem(boardKey))) } catch {}
  const board = Object.assign(document.createElement('section'), { className: 'canvas-board', tabIndex: 0 })
  board.setAttribute('aria-label', 'Infinite canvas. Double-click blank space or use Add card. Drag cards by their grip. Tap two ports to connect. Drag blank space to pan; pinch or scroll to zoom.')
  const plane = Object.assign(document.createElement('div'), { className: 'canvas-board-plane' })
  const svg = svgNode('svg', { class: 'canvas-wires', width: 1, height: 1 })
  const defs = svgNode('defs'), marker = svgNode('marker', { id: 'board-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' })
  marker.append(svgNode('path', { d: 'M 1 1 L 9 5 L 1 9', fill: 'none', stroke: '#a5e8de', 'stroke-width': 1.5 }))
  defs.append(marker); svg.append(defs)
  const draft = svgNode('path', { class: 'canvas-wire-draft', hidden: 'true' })
  svg.append(draft); plane.append(svg); board.append(plane); shell.append(board)
  const notice = Object.assign(document.createElement('div'), { className: 'canvas-board-notice', textContent: '' })
  notice.setAttribute('role', 'status'); shell.append(notice)
  const help = Object.assign(document.createElement('div'), { className: 'canvas-board-help' })
  const welcome = document.createElement('strong'); welcome.textContent = 'Start with a card'
  const instruction = document.createElement('span'); instruction.textContent = 'Add a title. Drag the grip to move it.\nTap a dot, then another card to connect.'
  help.append(welcome, instruction)
  shell.append(help)
  const quickAdd = button('Add a new card', 'canvas-board-add', '+ Add card')
  quickAdd.setAttribute('aria-label', 'New card'); onActivate(quickAdd, () => addCard()); shell.append(quickAdd)
  const edgeTools = Object.assign(document.createElement('div'), { className: 'canvas-edge-tools', hidden: true })
  const edgeLabel = document.createElement('span'), edgeDelete = button('Delete connection', '', 'Delete connection')
  edgeDelete.setAttribute('aria-label', 'Delete connection'); onActivate(edgeDelete, deleteSelection)
  edgeTools.append(edgeLabel, edgeDelete); shell.append(edgeTools)
  const viewTools = Object.assign(document.createElement('div'), { className: 'canvas-board-view-tools' })
  const out = button('Zoom out', '', '−'), fit = button('Fit cards', '', 'Fit'), into = button('Zoom in', '', '+')
  for (const b of [out, fit, into]) b.setAttribute('aria-label', b.title)
  viewTools.append(out, fit, into); shell.append(viewTools)

  function announce(text) { clearTimeout(noticeTimer); notice.textContent = text; noticeTimer = setTimeout(() => { if (!pending) notice.textContent = '' }, 5000) }
  function saveNow() {
    clearTimeout(saveTimer)
    try { localStorage.setItem(boardKey, JSON.stringify(model)) } catch { announce('Storage unavailable. Keep this page open to retain your cards.') }
  }
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 180) }
  window.addEventListener('pagehide', saveNow)
  function localPoint(e) { const r = board.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  function worldPoint(e) { return toWorld(localPoint(e), model.viewport) }
  function select(id) {
    selected = id
    for (const [key, element] of elements) element.classList.toggle('is-selected', key === id)
    for (const [key, wire] of wires) wire.group.classList.toggle('is-selected', key === id)
    const edge = model.edges.find(e => e.id === id)
    edgeTools.hidden = !edge
    if (edge) edgeLabel.textContent = `${model.cards.find(c => c.id === edge.source)?.title} → ${model.cards.find(c => c.id === edge.target)?.title}`
    else if (id && !pending) announce('Drag the grip to move. Tap a dot, then another card to connect.')
  }
  function clearPending() {
    pending = null; draft.setAttribute('hidden', 'true')
    board.classList.remove('is-connecting')
    for (const element of elements.values()) for (const port of element.querySelectorAll('.canvas-card-port')) port.setAttribute('aria-pressed', 'false')
  }
  function startConnection(port) {
    pending = { source: port.closest('.canvas-card').dataset.cardId, side: port.dataset.side }
    port.setAttribute('aria-pressed', 'true'); board.classList.add('is-connecting')
    announce('Source selected. Tap another card or dot for the destination. Escape cancels.')
  }
  function finishConnection(target, side) {
    const source = pending.source
    if (connect(model, source, target, pending.side, side || (pending.side === 'right' ? 'left' : 'right'))) {
      renderEdges(); save(); announce('Connection created from source to destination.')
    } else announce(source === target ? 'Choose a different card.' : 'This connection already exists.')
    clearPending()
  }
  function anchor(id, side) {
    const port = elements.get(id)?.querySelector(`[data-side="${side}"]`)
    if (!port) return null
    const r = port.getBoundingClientRect(), surface = board.getBoundingClientRect()
    return toWorld({ x: r.left + r.width / 2 - surface.left, y: r.top + r.height / 2 - surface.top }, model.viewport)
  }
  function positionEdges() {
    for (const edge of model.edges) {
      const wire = wires.get(edge.id), a = anchor(edge.source, edge.sourceSide), b = anchor(edge.target, edge.targetSide)
      if (!wire || !a || !b) continue
      const { d } = connectionCurve(a, b, edge.sourceSide, edge.targetSide)
      for (const path of [wire.line, wire.flow, wire.hit]) path.setAttribute('d', d)
    }
  }
  function renderEdges() {
    for (const [id, wire] of wires) if (!model.edges.some(e => e.id === id)) { wire.group.remove(); wires.delete(id) }
    for (const edge of model.edges) {
      if (wires.has(edge.id)) continue
      const group = svgNode('g', { class: 'canvas-wire', 'data-edge-id': edge.id })
      const line = svgNode('path', { class: 'canvas-wire-line', 'marker-end': 'url(#board-arrow)' })
      const flow = svgNode('path', { class: 'canvas-wire-flow', pathLength: 160 })
      const hit = svgNode('path', { class: 'canvas-wire-hit', tabindex: 0, role: 'button', 'aria-label': 'Select connection. Delete removes it.' })
      hit.addEventListener('click', e => { e.stopPropagation(); select(edge.id); announce('Connection selected. Press Delete to remove.') })
      hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(edge.id) } })
      group.append(line, flow, hit); svg.insertBefore(group, draft); wires.set(edge.id, { group, line, flow, hit })
    }
    positionEdges()
  }
  function applyViewport() {
    plane.style.transform = `translate(${model.viewport.x}px, ${model.viewport.y}px) scale(${model.viewport.zoom})`
    fit.textContent = `${Math.round(model.viewport.zoom * 100)}%`
  }
  function moveCard(card) {
    const element = elements.get(card.id)
    element.style.left = `${card.x}px`; element.style.top = `${card.y}px`
    positionEdges()
  }
  function updateCardState(card) {
    const element = elements.get(card.id), view = workView(card, workItems, workAvailable, native)
    element.dataset.status = view.status
    const label = element.querySelector('.canvas-card-status')
    label.textContent = `${view.label} · ${view.status}`; label.title = view.activity
    const control = element.querySelector('select')
    if (!native) { control.value = card.previewStatus; return }
    const choice = card.work ? JSON.stringify([card.work.agent, card.work.turnId]) : ''
    const options = [['', 'Local card'], ...workItems.map(w => [JSON.stringify([w.agent, w.turnId]), `${w.agent} · ${w.activity || w.status} · ${w.turnId}`])]
    if (choice && !options.some(([value]) => value === choice)) options.push([choice, `${card.work.agent} · Task unavailable`])
    const signature = JSON.stringify(options)
    if (control.dataset.options !== signature) {
      control.replaceChildren(...options.map(([value, text]) => Object.assign(document.createElement('option'), { value, textContent: text })))
      control.dataset.options = signature
    }
    control.value = choice
  }
  const cardResize = new ResizeObserver(positionEdges)
  function renderCard(card) {
    const element = Object.assign(document.createElement('article'), { className: 'canvas-card' }); element.dataset.cardId = card.id
    const glow = svgNode('svg', { class: 'canvas-card-glow', 'aria-hidden': 'true', width: '100%', height: '100%' })
    const rim = svgNode('rect', { x: 1, y: 1, width: 'calc(100% - 2px)', height: 'calc(100% - 2px)', rx: 14, pathLength: 100 })
    glow.append(rim); element.append(glow)
    const head = Object.assign(document.createElement('div'), { className: 'canvas-card-head' })
    const grip = button('Move card. Arrow keys move it.', 'canvas-card-grip', '⠿'); grip.setAttribute('aria-label', 'Move card')
    grip.addEventListener('keydown', e => {
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
      if (!delta) return
      e.preventDefault(); e.stopPropagation(); select(card.id)
      card.x += delta[0] * (e.shiftKey ? 40 : 10); card.y += delta[1] * (e.shiftKey ? 40 : 10); moveCard(card); save()
    })
    const status = Object.assign(document.createElement('span'), { className: 'canvas-card-status' })
    const remove = button('Delete card', 'canvas-card-delete', '×'); remove.setAttribute('aria-label', 'Delete card')
    onActivate(remove, () => deleteCard(card.id))
    head.append(grip, status, remove)
    const title = Object.assign(document.createElement('div'), { className: 'canvas-card-title', contentEditable: 'true', spellcheck: true, textContent: card.title })
    title.setAttribute('role', 'textbox'); title.setAttribute('aria-label', 'Card title'); title.setAttribute('aria-multiline', 'false')
    title.addEventListener('input', () => { card.title = title.textContent.slice(0, 500); save() })
    title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); title.blur(); getSelection()?.removeAllRanges(); board.focus() } })
    title.addEventListener('paste', e => {
      e.preventDefault(); const selection = getSelection()
      if (!selection?.rangeCount) return
      const range = selection.getRangeAt(0); range.deleteContents(); const text = document.createTextNode(e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ').slice(0, 500))
      range.insertNode(text); range.setStartAfter(text); range.collapse(true); selection.removeAllRanges(); selection.addRange(range)
      title.dispatchEvent(new Event('input'))
    })
    const control = document.createElement('select'); control.className = 'canvas-card-work'
    control.setAttribute('aria-label', native ? 'Bind actual Core task' : 'Preview status (simulation)')
    if (!native) for (const value of ['idle', 'running', 'completed', 'failed']) control.append(Object.assign(document.createElement('option'), { value, textContent: `Preview: ${value}` }))
    control.addEventListener('change', () => {
      if (native) { const binding = control.value ? JSON.parse(control.value) : null; if (binding) card.work = { agent: binding[0], turnId: binding[1] }; else delete card.work }
      else card.previewStatus = control.value
      updateCardState(card); save()
    })
    element.append(head, title, control)
    for (const side of ['left', 'right']) {
      const port = button(`Connect ${side} port. Tap source, then destination.`, 'canvas-card-port', '')
      port.dataset.side = side; port.setAttribute('aria-label', `Connect ${side} port`); port.setAttribute('aria-pressed', 'false')
      port.addEventListener('click', e => {
        e.stopPropagation(); if (suppressClick) return
        if (pending) finishConnection(card.id, side); else startConnection(port)
      })
      element.append(port)
    }
    elements.set(card.id, element); plane.append(element); moveCard(card); updateCardState(card); cardResize.observe(element)
    return element
  }
  function addCard(clientX = board.clientWidth / 2, clientY = board.clientHeight / 2, local = true) {
    const point = local ? toWorld({ x: clientX, y: clientY }, model.viewport) : worldPoint({ clientX, clientY })
    const card = { id: crypto.randomUUID(), title: 'New card', x: point.x - 96, y: point.y - 58, previewStatus: 'idle' }
    model.cards.push(card); const element = renderCard(card); select(card.id); save()
    help.hidden = true
    requestAnimationFrame(() => {
      const title = element.querySelector('.canvas-card-title'); title.focus()
      const range = document.createRange(); range.selectNodeContents(title); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
  }
  function deleteCard(id) {
    cardResize.unobserve(elements.get(id)); elements.get(id).remove(); elements.delete(id)
    model.cards = model.cards.filter(c => c.id !== id); model.edges = model.edges.filter(e => e.source !== id && e.target !== id)
    if (pending?.source === id) clearPending()
    renderEdges(); select(null); save(); help.hidden = model.cards.length > 0
  }
  function deleteSelection() {
    if (!selected) return
    if (elements.has(selected)) deleteCard(selected)
    else { model.edges = model.edges.filter(edge => edge.id !== selected); renderEdges(); select(null); save(); announce('Connection deleted.') }
  }
  board.addEventListener('dblclick', e => { if (e.target === board || e.target === plane) { e.preventDefault(); addCard(e.clientX, e.clientY, false) } })
  function pinchStart() {
    const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    clearPending(); gesture = { type: 'pinch', center, distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), viewport: { ...model.viewport } }
    suppressClick = true
  }
  board.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('select,[contenteditable],.canvas-card-delete')) return
    pointers.set(e.pointerId, localPoint(e)); board.setPointerCapture(e.pointerId)
    if (pointers.size >= 2) { pinchStart(); return }
    const port = e.target.closest('.canvas-card-port'), element = e.target.closest('.canvas-card'), start = worldPoint(e)
    if (port) gesture = { type: 'connect', id: e.pointerId, source: element.dataset.cardId, side: port.dataset.side, start: localPoint(e), moved: false }
    else if (element && !hand) {
      const card = model.cards.find(c => c.id === element.dataset.cardId); select(card.id)
      gesture = { type: 'card', id: e.pointerId, card, start, x: card.x, y: card.y, moved: false }
    } else gesture = { type: 'pan', id: e.pointerId, start: localPoint(e), viewport: { ...model.viewport }, edge: e.target.closest('.canvas-wire')?.dataset.edgeId, moved: false }
    if (!port && e.pointerType !== 'touch') e.preventDefault()
  })
  board.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, localPoint(e)); if (!gesture) return
    if (gesture.type === 'pinch') {
      if (pointers.size < 2) return
      const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      model.viewport = zoomAt(gesture.viewport, gesture.center, gesture.viewport.zoom * Math.hypot(b.x - a.x, b.y - a.y) / gesture.distance)
      model.viewport.x += center.x - gesture.center.x; model.viewport.y += center.y - gesture.center.y; applyViewport(); return
    }
    if (e.pointerId !== gesture.id) return
    const point = gesture.type === 'card' ? worldPoint(e) : localPoint(e)
    const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y
    if (!gesture.moved && Math.hypot(dx, dy) * (gesture.type === 'card' ? model.viewport.zoom : 1) < 5) return
    gesture.moved = true; suppressClick = true
    if (gesture.type === 'card') {
      gesture.card.x = gesture.x + dx; gesture.card.y = gesture.y + dy; moveCard(gesture.card)
    } else if (gesture.type === 'pan') {
      model.viewport = { ...gesture.viewport, x: gesture.viewport.x + dx, y: gesture.viewport.y + dy }; applyViewport()
    } else {
      if (!pending) startConnection(elements.get(gesture.source).querySelector(`[data-side="${gesture.side}"]`))
      const a = anchor(gesture.source, gesture.side), b = worldPoint(e)
      draft.removeAttribute('hidden'); draft.setAttribute('d', connectionCurve(a, b, gesture.side, gesture.side === 'right' ? 'left' : 'right').d)
    }
  })
  function releasePointer(e, cancelled = false) {
    if (!pointers.has(e.pointerId)) return
    if (!cancelled && gesture?.id === e.pointerId && !gesture.moved) {
      if (gesture.type === 'connect') {
        if (pending) finishConnection(gesture.source, gesture.side)
        else startConnection(elements.get(gesture.source).querySelector(`[data-side="${gesture.side}"]`))
      } else if (gesture.type === 'card' && pending) finishConnection(gesture.card.id)
      else if (gesture.type === 'pan' && !pending) select(gesture.edge || null)
    }
    if (!cancelled && gesture?.type === 'connect' && gesture.moved && pending) {
      const target = document.elementFromPoint(e.clientX, e.clientY), card = target?.closest('.canvas-card')
      if (card) finishConnection(card.dataset.cardId, target.closest('.canvas-card-port')?.dataset.side)
      else { clearPending(); announce('Connection cancelled. Drop on another card to connect.') }
    }
    if (board.hasPointerCapture(e.pointerId)) board.releasePointerCapture(e.pointerId)
    pointers.delete(e.pointerId)
    suppressClick = true
    if (cancelled) { clearPending(); gesture = null }
    else if (pointers.size === 1 && gesture?.type === 'pinch') {
      const [id, start] = [...pointers][0]; gesture = { type: 'pan', id, start, viewport: { ...model.viewport }, moved: true }
    } else if (!pointers.size) gesture = null
    save(); setTimeout(() => { if (!pointers.size) suppressClick = false }, 0)
  }
  board.addEventListener('pointerup', e => releasePointer(e))
  board.addEventListener('pointercancel', e => releasePointer(e, true))
  board.addEventListener('lostpointercapture', e => { if (pointers.has(e.pointerId)) releasePointer(e, true) })
  board.addEventListener('wheel', e => {
    if (e.target.closest('select,[contenteditable]')) return
    e.preventDefault(); model.viewport = zoomAt(model.viewport, localPoint(e), model.viewport.zoom * Math.exp(-e.deltaY * .0015)); applyViewport(); save()
  }, { passive: false })
  board.addEventListener('keydown', e => {
    if (e.target.closest('select,[contenteditable]')) return
    if (e.key === 'Escape') { clearPending(); select(null); announce('Selection cleared.') }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      deleteSelection()
    }
    if (e.target === board && e.key.startsWith('Arrow')) {
      const delta = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key]
      if (delta) { e.preventDefault(); model.viewport.x += delta[0]; model.viewport.y += delta[1]; applyViewport(); save() }
    }
  })
  function zoom(factor) { model.viewport = zoomAt(model.viewport, { x: board.clientWidth / 2, y: board.clientHeight / 2 }, model.viewport.zoom * factor); applyViewport(); save() }
  onActivate(out, () => zoom(1 / 1.2)); onActivate(into, () => zoom(1.2))
  onActivate(fit, () => {
    if (!model.cards.length) model.viewport = emptyBoard().viewport
    else {
      const left = Math.min(...model.cards.map(c => c.x)), top = Math.min(...model.cards.map(c => c.y))
      const right = Math.max(...model.cards.map(c => c.x + elements.get(c.id).offsetWidth)), bottom = Math.max(...model.cards.map(c => c.y + elements.get(c.id).offsetHeight))
      const zoom = Math.max(.25, Math.min(1, (board.clientWidth - 112) / (right - left), (board.clientHeight - 120) / (bottom - top)))
      model.viewport = { zoom, x: (board.clientWidth - (right - left) * zoom) / 2 - left * zoom, y: (board.clientHeight - (bottom - top) * zoom) / 2 - top * zoom }
    }
    applyViewport(); save()
  })
  const add = shell.querySelector('.canvas-rail-add'), selectTool = shell.querySelector('[aria-label="Select"]'), handTool = shell.querySelector('[aria-label="Hand"]')
  add.disabled = false; add.setAttribute('aria-label', 'Add card'); add.title = 'Add card'; onActivate(add, () => addCard())
  for (const tool of [selectTool, handTool]) tool.disabled = false
  function setHand(value) { hand = value; board.classList.toggle('is-hand', hand); selectTool.classList.toggle('is-active', !hand); handTool.classList.toggle('is-active', hand); selectTool.setAttribute('aria-pressed', String(!hand)); handTool.setAttribute('aria-pressed', String(hand)) }
  onActivate(selectTool, () => setHand(false)); onActivate(handTool, () => setHand(true)); setHand(false)
  applyViewport(); model.cards.forEach(renderCard); renderEdges(); help.hidden = model.cards.length > 0
  new ResizeObserver(() => { positionEdges(); }).observe(board)

  async function pollWork() {
    clearTimeout(pollTimer)
    if (!native || document.hidden || pollBusy) return
    pollBusy = true
    try { const result = await invoke('work_status'); if (!Array.isArray(result)) throw Error('Unsupported work snapshot'); workItems = result.filter(w => typeof w.agent === 'string' && typeof w.turnId === 'string'); workAvailable = true }
    catch { workAvailable = false }
    finally { pollBusy = false; model.cards.forEach(updateCardState); if (!document.hidden) pollTimer = setTimeout(pollWork, 3000) }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(pollTimer); saveNow() } else pollWork() })
  if (native) pollWork()
  return { addCard }
}
