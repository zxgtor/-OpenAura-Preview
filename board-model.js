// Document operations are independent of the renderer and transport.
export const PROJECT_KEY = 'openaura.infinite-canvas.projects.v3'
export const LEGACY_KEY = 'openaura.infinite-canvas.cards.v1'
export const INTERACTION_KEY = 'openaura.infinite-canvas.board.v1'
export const LIMITS = {cards:200, edges:1000, boards:30, text:20000, coordinate:1000000, bundle:140*1024*1024}
export const clone = value => JSON.parse(JSON.stringify(value))
export const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
const idOK = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value)
const stringOK = (value, max) => typeof value === 'string' && value.length <= max
const pointOK = value => Number.isFinite(value) && Math.abs(value) <= LIMITS.coordinate
const sizeOK = value => Number.isFinite(value) && value >= 120 && value <= 2000
const dataOK = value => value !== null && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 20000

export function emptyBoard(name = 'Untitled canvas') {
  return {id:uid('board'),name,cards:[],edges:[],view:{x:0,y:0,zoom:1}}
}
export function normalizeCard(card) {
  return {...card, width:card.width ?? (['image','video'].includes(card.type) ? 320 : 260), height:card.height ?? (['image','video'].includes(card.type) ? 260 : 160)}
}
// Drag previews never mutate documents that asynchronous writers may save.
export function previewGeometry(cards,kind,dx,dy) {
  const position=v=>Math.max(-LIMITS.coordinate,Math.min(LIMITS.coordinate,v)),size=v=>Math.max(120,Math.min(2000,v))
  return cards.map(c=>({id:c.id,x:kind==='cards'?position(c.x+dx):c.x,y:kind==='cards'?position(c.y+dy):c.y,width:kind==='resize'?size(c.width+dx):c.width,height:kind==='resize'?size(c.height+dy):c.height}))
}
export function validateBoard(board) {
  if (!board || !idOK(board.id) || !stringOK(board.name,100) || !board.name.trim()
    || !Array.isArray(board.cards) || board.cards.length > LIMITS.cards || !Array.isArray(board.edges) || board.edges.length > LIMITS.edges
    || !board.view || !pointOK(board.view.x) || !pointOK(board.view.y) || !Number.isFinite(board.view.zoom) || board.view.zoom < .1 || board.view.zoom > 4) throw Error('Invalid canvas document')
  const ids = new Set()
  for (const card of board.cards) {
    if (!card || !idOK(card.id) || ids.has(card.id) || !pointOK(card.x) || !pointOK(card.y) || !sizeOK(card.width) || !sizeOK(card.height)) throw Error('Invalid card')
    ids.add(card.id)
    if (card.agentTurn!==undefined && !idOK(card.agentTurn)) throw Error('Invalid Agent turn')
    if (card.generatedFrom!==undefined && !idOK(card.generatedFrom)) throw Error('Invalid generated reference')
    if (card.processedAssets!==undefined && (!Number.isInteger(card.processedAssets)||card.processedAssets<0||card.processedAssets>16)) throw Error('Invalid generated asset cursor')
    if (card.title!==undefined && !stringOK(card.title,500)) throw Error('Invalid card title')
    if (card.previewStatus!==undefined && !['idle','running','completed','failed','unknown','interrupted'].includes(card.previewStatus)) throw Error('Invalid preview status')
    if (card.work!==undefined && (!stringOK(card.work.agent,100)||!idOK(card.work.turnId)||![undefined,'canvas'].includes(card.work.source))) throw Error('Invalid task binding')
    if (card.type === 'text') { if (!stringOK(card.text,LIMITS.text)) throw Error('Invalid text card') }
    else if (['image','video'].includes(card.type)) { if (!idOK(card.mediaId) || !stringOK(card.name,256)) throw Error('Invalid media card') }
    else if (card.type === 'group') { if (!stringOK(card.title,100) || !Array.isArray(card.members) || !card.members.length || card.members.length > LIMITS.cards) throw Error('Invalid group') }
    else if (card.type === 'data') { if (!stringOK(card.nodeType,80) || !/^[a-z][\w.-]*$/.test(card.nodeType) || !stringOK(card.title,100) || !dataOK(card.data)) throw Error('Invalid data card') }
    else throw Error('Unsupported card type')
  }
  const membership = new Set()
  for (const group of board.cards.filter(card => card.type === 'group')) {
    for (const member of group.members) {
      if (membership.has(member) || !ids.has(member) || board.cards.find(card=>card.id===member)?.type==='group') throw Error('Invalid group membership')
      membership.add(member)
    }
  }
  const edges = new Set()
  for (const edge of board.edges) {
    if (!edge || !idOK(edge.id) || edges.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target) || edge.source===edge.target || !stringOK(edge.label,120)) throw Error('Invalid link')
    edges.add(edge.id)
    if (![undefined,'left','right'].includes(edge.sourceSide)||![undefined,'left','right'].includes(edge.targetSide)) throw Error('Invalid link port')
  }
  return board
}
export function validateCollection(value) {
  if (!value || value.schemaVersion!==3 || !Array.isArray(value.boards) || !value.boards.length || value.boards.length>LIMITS.boards) throw Error('Invalid saved canvases')
  const ids = new Set()
  value.boards.forEach(board=>{validateBoard(board);if(ids.has(board.id))throw Error('Duplicate canvas');ids.add(board.id)})
  if (!ids.has(value.active)) throw Error('Invalid active canvas')
  return value
}
export function loadCollection(storage) {
  const saved = storage.getItem(PROJECT_KEY)
  if (saved !== null) return migrateInteractions(validateCollection(JSON.parse(saved)),storage)
  const board = emptyBoard('My canvas')
  const legacy = storage.getItem(LEGACY_KEY)
  if (legacy !== null) {
    const record = JSON.parse(legacy)
    if (![1,2].includes(record?.schemaVersion) || !Array.isArray(record.cards)) throw Error('Unsupported legacy board')
    board.cards = record.cards.map(card=>normalizeCard(record.schemaVersion===1?{...card,type:'text'}:card))
    validateBoard(board)
  }
  return migrateInteractions({schemaVersion:3,active:board.id,boards:[board]},storage,legacy===null)
}
// Keep both old saves intact. A separate board preserves the published canvas
// when a desktop workbench collection is already present on the same origin.
function migrateInteractions(collection,storage,replaceDefault=false) {
  if(collection.migrations?.interactionV1)return collection
  const saved=storage.getItem(INTERACTION_KEY)
  if(saved!==null) {
    const raw=JSON.parse(saved)
    if(raw?.schemaVersion!==1||!Array.isArray(raw.cards)||!Array.isArray(raw.edges))throw Error('Invalid previous interaction canvas')
    if(raw.cards.length) {
      if(raw.cards.length>LIMITS.cards||raw.edges.length>LIMITS.edges)throw Error('Previous canvas exceeds workbench limits; its original save is retained')
      const b=emptyBoard('Previous canvas'),ids=new Map()
      b.cards=raw.cards.map(c=>{if(!c||typeof c.id!=='string'||ids.has(c.id))throw Error('Invalid previous card');const id=uid('card');ids.set(c.id,id);return normalizeCard({id,type:'text',text:String(c.title??''),title:String(c.title??''),x:c.x,y:c.y,previewStatus:c.previewStatus||'idle',...(c.work?{work:clone(c.work)}:{})})})
      b.edges=raw.edges.map(e=>({id:uid('edge'),source:ids.get(e.source),target:ids.get(e.target),sourceSide:e.sourceSide,targetSide:e.targetSide,label:''}))
      // v1 uses the top-left origin; v3 centers the world at the viewport center.
      b.view={x:raw.viewport?.x??0,y:raw.viewport?.y??0,zoom:raw.viewport?.zoom??1}
      b.viewOrigin='top-left'
      validateBoard(b)
      if(replaceDefault)collection.boards=[]
      collection.boards.push(b);collection.active=b.id
    }
  }
  collection.migrations={...collection.migrations,interactionV1:true}
  return validateCollection(collection)
}
export function expandedSelection(board, selection) {
  const ids = new Set(selection)
  for (const card of board.cards) if (ids.has(card.id) && card.type==='group') card.members.forEach(id=>ids.add(id))
  return ids
}
export function removeCards(board, selection) {
  const ids = expandedSelection(board,selection)
  board.cards = board.cards.filter(card=>!ids.has(card.id))
  board.edges = board.edges.filter(edge=>!ids.has(edge.source)&&!ids.has(edge.target))
  for (const group of board.cards.filter(card=>card.type==='group')) group.members=group.members.filter(id=>!ids.has(id))
  board.cards=board.cards.filter(card=>card.type!=='group'||card.members.length)
  const kept=new Set(board.cards.map(card=>card.id))
  board.edges=board.edges.filter(edge=>kept.has(edge.source)&&kept.has(edge.target))
}
export function fragment(board, selection) {
  const ids=expandedSelection(board,selection)
  const cards=clone(board.cards.filter(card=>ids.has(card.id)))
  cards.filter(card=>card.type==='group').forEach(card=>{card.members=card.members.filter(id=>ids.has(id))})
  return {cards,edges:clone(board.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)))}
}
export function pasteFragment(board, content, offset=32) {
  const map=new Map(content.cards.map(card=>[card.id,uid('card')]))
  const cards=clone(content.cards).map(card=>({...card,id:map.get(card.id),x:card.x+offset,y:card.y+offset,...(card.type==='group'?{members:card.members.map(id=>map.get(id))}:{})}))
  cards.forEach(card=>{delete card.agentTurn;delete card.generatedFrom;delete card.processedAssets})
  board.cards.push(...cards)
  board.edges.push(...content.edges.map(edge=>({...edge,id:uid('edge'),source:map.get(edge.source),target:map.get(edge.target)})))
  return cards.map(card=>card.id)
}
export function groupCards(board, selection) {
  const cards=board.cards.filter(card=>selection.has(card.id)&&card.type!=='group')
  if (cards.length<2) throw Error('Select at least two ungrouped cards')
  if (board.cards.some(card=>card.type==='group'&&card.members.some(id=>selection.has(id)))) throw Error('Ungroup these cards first')
  const x=Math.min(...cards.map(card=>card.x))-20,y=Math.min(...cards.map(card=>card.y))-44
  const width=Math.max(...cards.map(card=>card.x+card.width))-x+20,height=Math.max(...cards.map(card=>card.y+card.height))-y+20
  if(width>2000||height>2000)throw Error('Move the cards closer before grouping')
  const group={id:uid('card'),type:'group',title:'Group',x,y,width,height,members:cards.map(card=>card.id)}
  board.cards.push(group)
  return group.id
}
export function ungroupCards(board, selection) {
  const groups=new Set(board.cards.filter(card=>card.type==='group'&&selection.has(card.id)).map(card=>card.id))
  board.cards=board.cards.filter(card=>!groups.has(card.id))
  board.edges=board.edges.filter(edge=>!groups.has(edge.source)&&!groups.has(edge.target))
}
export function upstreamContext(board, selection) {
  const ids=expandedSelection(board,selection)
  let changed=true
  while(changed) {
    changed=false
    for(const edge of board.edges) if(ids.has(edge.target)&&!ids.has(edge.source)){ids.add(edge.source);changed=true}
    for(const card of board.cards) if(ids.has(card.id)&&card.type==='group') for(const id of card.members) if(!ids.has(id)){ids.add(id);changed=true}
  }
  return clone(board.cards.filter(card=>ids.has(card.id)))
}
export function applyOperations(board, ops) {
  if(!Array.isArray(ops)||ops.length>64)throw Error('Supply at most 64 operations')
  for(const op of ops) {
    if(op.op==='add') board.cards.push(normalizeCard(clone(op.card)))
    else if(op.op==='update') {
      const card=board.cards.find(card=>card.id===op.id)
      if(!card)throw Error('Card not found')
      const patch=clone(op.patch)
      for(const key of Object.keys(patch))if(!['x','y','width','height','text','title','data'].includes(key))throw Error('Unsupported card property')
      Object.assign(card,patch)
    } else if(op.op==='remove') removeCards(board,new Set(op.ids))
    else if(op.op==='link') board.edges.push({...clone(op.edge),id:op.edge.id||uid('edge'),label:op.edge.label||''})
    else if(op.op==='unlink') board.edges=board.edges.filter(edge=>edge.id!==op.id)
    else throw Error('Unsupported canvas operation')
  }
  validateBoard(board)
}

export class BoardStore {
  constructor(storage) { this.storage=storage;this.collection=loadCollection(storage);this.histories=new Map() }
  get board() { return this.collection.boards.find(board=>board.id===this.collection.active) }
  history(id) { if(!this.histories.has(id))this.histories.set(id,{undo:[],redo:[]});return this.histories.get(id) }
  persist() { validateCollection(this.collection);this.storage.setItem(PROJECT_KEY,JSON.stringify(this.collection)) }
  edit(fn,id=this.board.id) {
    const before=clone(this.collection), board=this.collection.boards.find(board=>board.id===id)
    if(!board)throw Error('Canvas no longer exists')
    const old=clone(board)
    try { fn(board);this.persist() }
    catch(error){this.collection=before;throw error}
    const history=this.history(id);history.undo.push(old);if(history.undo.length>50)history.undo.shift();history.redo=[]
  }
  change(fn) { const before=clone(this.collection);try {fn(this.collection);this.persist()}catch(error){this.collection=before;throw error} }
  restore(direction) {
    const board=this.board, history=this.history(board.id), source=history[direction]
    if(!source.length)return
    const before=clone(this.collection), snapshot=source.at(-1)
    const index=this.collection.boards.findIndex(item=>item.id===board.id)
    this.collection.boards[index]={...clone(snapshot),view:clone(board.view)}
    try {this.persist()}catch(error){this.collection=before;throw error}
    source.pop();history[direction==='undo'?'redo':'undo'].push(clone(board))
  }
}
