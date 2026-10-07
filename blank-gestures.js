// Explicit pointer taps also work when a touch browser omits compatibility
// dblclick events. A moved/cancelled/multi-touch gesture never creates a card.
export function blankTap(previous, current) {
  if(!current.blank||current.moved||current.duration>350)return {previous:null,add:false}
  if(previous&&current.time-previous.time<420&&Math.hypot(current.x-previous.x,current.y-previous.y)<24)return {previous:null,add:true}
  return {previous:current,add:false}
}

export function installCanvasGestures({shell,canvas,layer,world,svg,point,getView,setView,add,beginPinch}) {
  const touches=new Map()
  let pinch=null,lastTap=null,suppressDoubleUntil=0
  const blank=target=>[canvas,layer,world,svg].includes(target)
  const eligible=target=>!target.closest('input,textarea,select,video,.board-popover,.board-selection-tools,.canvas-rail,.canvas-controls,.canvas-background-menu,.board-add,.canvas-move-handle,.board-minimap')
  shell.addEventListener('dblclick',e=>{
    if(!blank(e.target)||performance.now()<suppressDoubleUntil)return
    e.preventDefault();add(point(e))
  })
  const distance=()=>{const[a,b]=[...touches.values()];return Math.hypot(a.x-b.x,a.y-b.y)}
  const center=()=>{const[a,b]=[...touches.values()];return {clientX:(a.x+b.x)/2,clientY:(a.y+b.y)/2}}
  shell.addEventListener('pointerdown',e=>{
    if(e.pointerType!=='touch'||!eligible(e.target))return
    touches.set(e.pointerId,{x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,time:performance.now(),blank:blank(e.target),moved:false})
    if(touches.size===2){lastTap=null;beginPinch();pinch={distance:distance(),view:getView(),world:point(center())};for(const t of touches.values())t.moved=true;e.preventDefault();e.stopPropagation();shell.setPointerCapture(e.pointerId)}
  },true)
  shell.addEventListener('pointermove',e=>{
    const t=touches.get(e.pointerId);if(!t)return
    t.x=e.clientX;t.y=e.clientY;t.moved||=Math.hypot(t.x-t.startX,t.y-t.startY)>8
    if(!pinch||touches.size!==2)return
    e.preventDefault();e.stopPropagation()
    const r=canvas.getBoundingClientRect(),c=center(),zoom=Math.max(.1,Math.min(4,pinch.view.zoom*distance()/Math.max(1,pinch.distance)))
    setView({x:c.clientX-r.left-r.width/2-pinch.world.x*zoom,y:c.clientY-r.top-r.height/2-pinch.world.y*zoom,zoom})
  },true)
  function finish(e,cancelled){
    const t=touches.get(e.pointerId);if(!t)return
    touches.delete(e.pointerId)
    if(pinch){pinch=null;for(const remaining of touches.values())remaining.moved=true;e.stopPropagation();return}
    if(cancelled){lastTap=null;return}
    const result=blankTap(lastTap,{...t,x:e.clientX,y:e.clientY,time:performance.now(),duration:performance.now()-t.time})
    lastTap=result.previous
    if(result.add){suppressDoubleUntil=performance.now()+800;e.preventDefault();add(point(e))}
  }
  shell.addEventListener('pointerup',e=>finish(e,false),true)
  shell.addEventListener('pointercancel',e=>finish(e,true),true)
  window.addEventListener('blur',()=>{touches.clear();pinch=null;lastTap=null})
}
