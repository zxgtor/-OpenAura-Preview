import { clone, uid, validateBoard, LIMITS } from './board-model.js?v=20261007-workbench-1'
import { mediaFile, validMedia, checkMedia } from './media-store.js?v=20261007-workbench-1'
export function blobData(blob) {
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Could not read media'));r.readAsDataURL(blob)})
}
export async function exportBoard(board) {
  const assets=[];let size=JSON.stringify(board).length
  for(const card of board.cards.filter(c=>['image','video'].includes(c.type))) {
    if(assets.some(a=>a.id===card.mediaId))continue
    const blob=await mediaFile('get',card.mediaId)
    if(!validMedia(blob,card.type))throw Error(`Cannot export missing media: ${card.name}`)
    size+=Math.ceil(blob.size/3)*4+128
    if(size>LIMITS.bundle)throw Error('Canvas bundle exceeds 140 MiB')
    assets.push({id:card.mediaId,type:card.type,data:await blobData(blob)})
  }
  return new Blob([JSON.stringify({format:'openaura-canvas',version:1,board,assets})],{type:'application/json'})
}
export async function importBoard(file,store) {
  if(file.size>LIMITS.bundle)throw Error('Canvas bundle exceeds 140 MiB')
  const bundle=JSON.parse(await file.text())
  if(bundle?.format!=='openaura-canvas'||bundle.version!==1||!Array.isArray(bundle.assets)||bundle.assets.length>LIMITS.cards)throw Error('Unsupported canvas bundle')
  validateBoard(bundle.board)
  const board=clone(bundle.board),ids=new Map(board.cards.map(c=>[c.id,uid('card')])),assets=new Map(),referenced=new Set()
  for(const asset of bundle.assets) {
    if(!asset||assets.has(asset.id)||!['image','video'].includes(asset.type)||typeof asset.data!=='string'||!/^data:(image\/(png|jpeg|webp|gif|avif|bmp)|video\/(mp4|webm|ogg));base64,[A-Za-z0-9+/]*={0,2}$/.test(asset.data))throw Error('Invalid media bundle')
    const [header,encoded]=asset.data.split(','),blob=new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:header.slice(5,-7)})
    if(!validMedia(blob,asset.type))throw Error('Invalid imported media')
    assets.set(asset.id,{id:uid('media'),blob,type:asset.type})
  }
  for(const card of board.cards) {
    delete card.agentTurn;delete card.generatedFrom;delete card.processedAssets
    card.id=ids.get(card.id)
    if(card.type==='group')card.members=card.members.map(id=>ids.get(id))
    if(['image','video'].includes(card.type)){const asset=assets.get(card.mediaId);if(!asset||asset.type!==card.type)throw Error('Missing bundle media');referenced.add(card.mediaId);card.mediaId=asset.id}
  }
  if(referenced.size!==assets.size)throw Error('Unreferenced bundle media')
  board.id=uid('board');board.name=board.name.slice(0,85)+' (imported)';board.edges=board.edges.map(e=>({...e,id:uid('edge'),source:ids.get(e.source),target:ids.get(e.target)}));validateBoard(board)
  if(store.collection.boards.length>=LIMITS.boards)throw Error('Canvas limit reached')
  const written=[]
  try{for(const a of assets.values()){await checkMedia(a.blob,a.type);await mediaFile('put',a.id,a.blob);written.push(a.id)}store.change(c=>{c.boards.push(board);c.active=board.id})}
  catch(error){const cleanup=await Promise.allSettled(written.map(id=>mediaFile('delete',id)));if(cleanup.some(r=>r.status==='rejected'))throw Error(`${error.message}; unused import media remains`);throw error}
  return board
}
