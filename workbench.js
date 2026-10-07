import { BoardStore, clone, uid, emptyBoard, normalizeCard, previewGeometry, LIMITS, expandedSelection, removeCards, fragment, pasteFragment, groupCards, ungroupCards, upstreamContext, applyOperations } from './board-model.js?v=20261007-workbench-1'
import { mediaFile, validMedia, checkMedia } from './media-store.js?v=20261007-workbench-1'
import { exportBoard, importBoard, blobData } from './board-io.js?v=20261007-workbench-1'
import { connectionCurve, workView } from './board-model.mjs?v=20261007-workbench-1'
import { onActivate } from './canvas-board.js?v=20261007-workbench-1'
import { installCanvasGestures } from './blank-gestures.js?v=20261007-workbench-1'

export function createTextBoard({button,layer,canvas,state,error}) {
  const shell=button.closest('.shell'),world=layer.querySelector('.board-world')
  const invoke=window.__TAURI__?.core?.invoke,listen=window.__TAURI__?.event?.listen,native=typeof invoke==='function'
  let workItems=[],workAvailable=false,canvasAvailable=false,workPolling=false,lastWorkPoll=0
  const canvasStates=new Map()
  const showError=message=>{error.textContent=message;error.hidden=false}
  let store
  try{store=new BoardStore(localStorage)}catch(e){showError(`Saved canvases cannot be read and will not be overwritten: ${e.message}`);return}
  const board=()=>store.board,els=new Map(),urls=new Map(),renderers=new Map(),jobs=new Map()
  let selection=new Set(),selectedEdge=null,linkSource=null,clipboard=null,typing=null,drag=null,viewTimer,mode='select',busy=false,suppressPortClick=false
  const svgNS='http://www.w3.org/2000/svg',svg=document.createElementNS(svgNS,'svg');svg.classList.add('board-links');world.append(svg)
  const marquee=document.createElement('div');marquee.className='board-marquee';marquee.hidden=true;layer.append(marquee)
  const map=document.createElement('canvas');map.className='board-minimap';map.width=180;map.height=110;map.tabIndex=0;map.setAttribute('aria-label','Canvas minimap; click to navigate');shell.append(map)
  const panel=document.createElement('section');panel.className='board-popover';panel.hidden=true;panel.setAttribute('role','dialog');shell.append(panel)
  const actions=document.createElement('div');actions.className='board-selection-tools';actions.hidden=true;shell.append(actions)
  const name=document.createElement('span');name.className='board-name';shell.append(name)
  const clamp=v=>Math.max(-LIMITS.coordinate,Math.min(LIMITS.coordinate,v))
  const run=async fn=>{try{await fn()}catch(e){showError(e.message||String(e));render();for(const c of board().cards){const editor=els.get(c.id)?.querySelector('textarea');if(editor)editor.value=c.text}}}
  const makeButton=(label,fn,parent=panel)=>{const el=document.createElement('button');el.type='button';el.textContent=label;onActivate(el,()=>run(fn));parent.append(el);return el}
  function input(value,label,parent=panel){const el=document.createElement('input');el.value=value;el.setAttribute('aria-label',label);parent.append(el);return el}
  function closePanel(){panel.hidden=true;button.setAttribute('aria-expanded','false')}
  function openPanel(title,anchor=button){closePanel();panel.replaceChildren();panel.hidden=false;panel.setAttribute('aria-label',title);const h=document.createElement('strong');h.textContent=title;panel.append(h);const a=anchor.getBoundingClientRect(),s=shell.getBoundingClientRect();panel.style.left=`${Math.max(8,Math.min(a.right-s.left+8,s.width-300))}px`;panel.style.top=`${Math.max(36,Math.min(a.top-s.top,s.height-360))}px`}
  function point(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left-r.width/2-state.pan.x)/state.zoom,y:(e.clientY-r.top-r.height/2-state.pan.y)/state.zoom}}
  function flush(){if(!typing)return;const t=typing;typing=null;clearTimeout(t.timer);if(t.text!==t.before)store.edit(b=>{const c=b.cards.find(c=>c.id===t.id);if(c)c.text=t.text},t.board)}
  function edit(fn){flush();store.edit(fn);render()}
  function saveView(){clearTimeout(viewTimer);store.change(()=>board().view={x:state.pan.x,y:state.pan.y,zoom:state.zoom})}
  function syncView(){world.style.transform=`translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`;drawMap();clearTimeout(viewTimer);const id=board().id,v={x:state.pan.x,y:state.pan.y,zoom:state.zoom};viewTimer=setTimeout(()=>run(()=>store.change(c=>{const b=c.boards.find(b=>b.id===id);if(b)b.view=v})),180)}
  function setView(v){state.pan={x:v.x,y:v.y};state.zoom=v.zoom;syncView()}
  function bounds(cards=board().cards){if(!cards.length)return{x:-180,y:-120,width:360,height:240};const x=Math.min(...cards.map(c=>c.x)),y=Math.min(...cards.map(c=>c.y));return{x,y,width:Math.max(...cards.map(c=>c.x+c.width))-x,height:Math.max(...cards.map(c=>c.y+c.height))-y}}
  function fit(cards=board().cards){const b=bounds(cards),r=canvas.getBoundingClientRect(),zoom=Math.max(.1,Math.min(2,(r.width-140)/(b.width+40),(r.height-120)/(b.height+40)));setView({x:-(b.x+b.width/2)*zoom,y:-(b.y+b.height/2)*zoom,zoom})}
  let mapBox
  function drawMap(){const ctx=map.getContext('2d'),r=canvas.getBoundingClientRect(),v={x:(-r.width/2-state.pan.x)/state.zoom,y:(-r.height/2-state.pan.y)/state.zoom,width:r.width/state.zoom,height:r.height/state.zoom},b=bounds([...displayCards(),v]),scale=Math.min(164/(b.width+40),94/(b.height+40));mapBox={x:b.x-20,y:b.y-20,scale};ctx.clearRect(0,0,180,110);for(const c of displayCards()){ctx.fillStyle=selection.has(c.id)?'#83dace':c.type==='group'?'#91a4af33':'#91a4af99';ctx.fillRect(8+(c.x-mapBox.x)*scale,8+(c.y-mapBox.y)*scale,Math.max(3,c.width*scale),Math.max(3,c.height*scale))}ctx.strokeStyle='#92e0d7';ctx.strokeRect(8+(v.x-mapBox.x)*scale,8+(v.y-mapBox.y)*scale,v.width*scale,v.height*scale)}
  map.addEventListener('click',e=>{const r=map.getBoundingClientRect(),x=(e.clientX-r.left)*180/r.width,y=(e.clientY-r.top)*110/r.height;setView({x:-(mapBox.x+(x-8)/mapBox.scale)*state.zoom,y:-(mapBox.y+(y-8)/mapBox.scale)*state.zoom,zoom:state.zoom})});map.addEventListener('keydown',e=>{if(e.key==='Enter'){fit();e.preventDefault()}})
  const add=document.createElement('button');add.className='board-add';add.type='button';add.textContent='+ Add card';add.setAttribute('aria-label','Add a card');shell.append(add);onActivate(add,()=>run(addMenu))
  const help=document.createElement('div');help.className='board-help';help.textContent='Double-click or double-tap blank space to add a text card.\nDrag headers to move. Tap two dots to connect.';shell.append(help)
  const notice=document.createElement('div');notice.className='board-notice';notice.setAttribute('role','status');shell.append(notice)
  const viewTools=document.createElement('div');viewTools.className='board-view-tools';shell.append(viewTools);makeButton('−',()=>setView({x:state.pan.x,y:state.pan.y,zoom:Math.max(.1,state.zoom/1.2)}),viewTools);makeButton('Fit',()=>fit(),viewTools);makeButton('+',()=>setView({x:state.pan.x,y:state.pan.y,zoom:Math.min(4,state.zoom*1.2)}),viewTools)
  function announce(text){notice.textContent=text;clearTimeout(notice.timer);notice.timer=setTimeout(()=>notice.textContent='',4500)}
  function refreshSelection(){for(const[id,el]of els)el.classList.toggle('is-selected',selection.has(id));actions.hidden=!selection.size&&!selectedEdge;help.hidden=!!board().cards.length;drawEdges();drawMap()}
  function select(id,toggle=false){selectedEdge=null;if(toggle){selection.has(id)?selection.delete(id):selection.add(id)}else if(!selection.has(id))selection=new Set([id]);refreshSelection()}
  function connect(source,target,sourceSide='right',targetSide='left') {
    linkSource=null
    if(source===target||board().edges.some(e=>e.source===source&&e.target===target)){announce('Choose a different card without this connection.');return}
    edit(b=>b.edges.push({id:uid('edge'),source,target,sourceSide,targetSide,label:''}))
    announce('Connection created from source to destination.')
  }
  const node=(tag,attrs={})=>{const el=document.createElementNS(svgNS,tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,v);return el}
  function anchor(id,side){const port=els.get(id)?.querySelector('.board-port.is-'+(side==='left'?'in':'out'));if(!port)return null;const r=port.getBoundingClientRect();return point({clientX:r.left+r.width/2,clientY:r.top+r.height/2})}
  function drawEdges(){
    svg.replaceChildren()
    const defs=node('defs'),marker=node('marker',{id:'workbench-arrow',viewBox:'0 0 10 10',refX:10,refY:5,markerWidth:6,markerHeight:6,orient:'auto',markerUnits:'userSpaceOnUse'})
    marker.append(node('path',{d:'M0 0 L10 5 L0 10 Z',fill:'#a5dcd2'}));defs.append(marker);svg.append(defs)
    for(const e of board().edges){
      const sourceSide=e.sourceSide||'right',targetSide=e.targetSide||'left',a=anchor(e.source,sourceSide),b=anchor(e.target,targetSide);if(!a||!b)continue
      const curve=connectionCurve(a,b,sourceSide,targetSide),group=node('g',{'data-edge-id':e.id}),path=node('path',{d:curve.d,class:'board-link','marker-end':'url(#workbench-arrow)'})
      path.classList.toggle('is-selected',selectedEdge===e.id)
      const flow=node('path',{d:curve.d,class:'board-link-flow',pathLength:160}),hit=node('path',{d:curve.d,class:'board-link-hit',tabindex:0,role:'button','aria-label':'Edit connection '+(e.label||'unlabeled')})
      const choose=()=>{selection.clear();selectedEdge=e.id;refreshSelection();linkEditor(e)}
      onActivate(hit,choose);hit.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();choose()}});group.append(path,flow,hit)
      if(e.label){const label=node('text',{x:(a.x+b.x)/2,y:(a.y+b.y)/2-8,class:'board-link-label'});label.textContent=e.label;onActivate(label,choose);group.append(label)}
      svg.append(group)
    }
  }
  function statusFor(c){
    if(native&&c.work?.source==='canvas'){
      const observed=canvasStates.get(c.work.turnId)
      if(!canvasAvailable)return {status:'unknown',label:'Core unavailable',activity:'Canvas status could not be read.'}
      if(!observed)return {status:'unknown',label:'Core task unavailable',activity:'This Canvas turn is not in the current host.'}
      if(observed.status==='running'){const live=workView(c,workItems,workAvailable,true);return {...live,label:'Core Canvas Agent'}}
      return observed
    }
    return workView(c,workItems,workAvailable,native)
  }
  function updateStatus(c,el){const view=statusFor(c);el.dataset.status=view.status;const label=el.querySelector('.board-card-status');label.textContent=view.label+' · '+view.status;label.title=view.activity}
  async function pollWork(){
    if(!invoke||workPolling||document.hidden||Date.now()-lastWorkPoll<3000)return
    workPolling=true;lastWorkPoll=Date.now()
    try{const result=await invoke('work_status'),items=Array.isArray(result)?result:result?.items;if(!Array.isArray(items))throw Error('Invalid work status');workItems=items;workAvailable=true}catch{workAvailable=false}
    finally{workPolling=false;for(const c of displayCards()){const el=els.get(c.id);if(el)updateStatus(c,el)}}
  }
  function cardProperties(){
    const c=board().cards.find(c=>selection.has(c.id));if(!c)return
    openPanel('Card properties');const title=input(c.title||c.name||(c.type==='text'?'Text':c.type),'Card title');title.maxLength=['group','data'].includes(c.type)?100:500
    makeButton('Save title',()=>{edit(b=>{const card=b.cards.find(item=>item.id===c.id);if(card)card.title=title.value});closePanel()})
    const control=document.createElement('select');control.setAttribute('aria-label',native?'Core task':'Preview status');panel.append(control)
    const option=(value,text)=>control.append(Object.assign(document.createElement('option'),{value,textContent:text}))
    if(!native){for(const status of ['idle','running','completed','failed'])option(status,'Preview: '+status);control.value=c.previewStatus||'idle'}
    else{option('','Local card');for(const item of workItems)option(JSON.stringify({agent:item.agent,turnId:item.turnId}),item.agent+' · '+item.status+' · '+item.turnId);if(c.work?.source==='canvas')option(JSON.stringify(c.work),'Canvas Agent · '+c.work.agent);if(c.work){const value=JSON.stringify(c.work);if(![...control.options].some(o=>o.value===value))option(value,'Task unavailable');control.value=value}}
    control.addEventListener('change',()=>run(()=>edit(b=>{const card=b.cards.find(item=>item.id===c.id);if(!card)return;if(!native)card.previewStatus=control.value;else if(control.value)card.work=JSON.parse(control.value);else delete card.work})))
    const info=document.createElement('p');info.textContent=native?'Shows actual status from the current OpenAura host. Connections do not run tasks.':'Preview status only simulates appearance. Agent execution requires the desktop host.';panel.append(info)
  }

  function linkEditor(e){openPanel('Link');const label=input(e.label,'Link label');label.maxLength=120;makeButton('Save link',()=>{edit(b=>{const edge=b.edges.find(edge=>edge.id===e.id);if(edge)edge.label=label.value});closePanel()});makeButton('Delete link',()=>{edit(b=>b.edges=b.edges.filter(edge=>edge.id!==e.id));selectedEdge=null;closePanel();refreshSelection()})}
  const cardResize=new ResizeObserver(()=>drawEdges())
  function release(id){const el=els.get(id);if(el)cardResize.unobserve(el);el?.querySelector('video')?.pause();el?.remove();els.delete(id);if(urls.has(id)){URL.revokeObjectURL(urls.get(id));urls.delete(id)}}
  function mediaContent(el,c){const body=document.createElement('div');body.className='board-media';body.textContent='Loading…';el.append(body);mediaFile('get',c.mediaId).then(blob=>{if(!el.isConnected)return;if(!validMedia(blob,c.type))throw Error('Missing media');const media=document.createElement(c.type==='image'?'img':'video'),url=URL.createObjectURL(blob);urls.set(c.id,url);if(c.type==='image'){media.alt=c.name;media.draggable=false}else{media.controls=true;media.preload='metadata';media.playsInline=true}media.onerror=()=>{body.textContent='This media format cannot be displayed';URL.revokeObjectURL(url);urls.delete(c.id)};media.src=url;body.replaceChildren(media)}).catch(()=>body.textContent='Media could not be loaded from local storage')}
  function dataContent(el,c){let body=el.querySelector('.board-data');if(!body){body=document.createElement('div');body.className='board-data';el.append(body)}body.replaceChildren();const renderer=renderers.get(c.nodeType);if(renderer){try{renderer(body,clone(c.data),clone(c))}catch{body.textContent='Card renderer failed'}}else{const pre=document.createElement('pre');pre.textContent=JSON.stringify(c.data,null,2);body.append(pre)}}
  function renderCard(c){let el=els.get(c.id);if(!el){el=document.createElement('article');el.className='board-card';el.dataset.cardId=c.id;els.set(c.id,el);world.append(el);const glow=node('svg',{class:'board-card-glow',width:'100%',height:'100%','aria-hidden':'true'});glow.append(node('rect',{x:1,y:1,width:'calc(100% - 2px)',height:'calc(100% - 2px)',rx:8,pathLength:100}));el.append(glow);const status=document.createElement('span');status.className='board-card-status';el.append(status);const grip=document.createElement('button');grip.type='button';grip.className='board-card-grip';grip.setAttribute('aria-label',`Move ${c.type} card; use arrow keys to move`);el.append(grip)
    grip.addEventListener('dblclick',e=>{e.stopPropagation();select(c.id);run(cardProperties)});grip.addEventListener('pointerdown',e=>{if(e.button!==0)return;run(()=>{flush();select(c.id,e.shiftKey);if(!selection.has(c.id))return;e.preventDefault();e.stopPropagation();drag={kind:'cards',pointer:e.pointerId,start:point(e),cards:clone(board().cards.filter(c=>expandedSelection(board(),selection).has(c.id))),board:board().id,preview:[]};grip.setPointerCapture(e.pointerId)})});grip.addEventListener('pointermove',moveDrag);grip.addEventListener('pointerup',endDrag);grip.addEventListener('pointercancel',cancelDrag)
    grip.addEventListener('keydown',e=>{if(e.key==='Enter'){select(c.id,e.shiftKey);return}const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(d){e.preventDefault();run(()=>{select(c.id);const ids=expandedSelection(board(),selection);edit(b=>b.cards.filter(c=>ids.has(c.id)).forEach(c=>{c.x=clamp(c.x+d[0]*(e.shiftKey?1:10));c.y=clamp(c.y+d[1]*(e.shiftKey?1:10))}))})}})
    el.addEventListener('pointerdown',e=>{if(!e.target.closest('button,input,textarea,video'))select(c.id,e.shiftKey)})
    if(c.type==='text'){const editor=document.createElement('textarea');editor.maxLength=LIMITS.text;editor.placeholder='Write something…';editor.setAttribute('aria-label','Text card content');editor.value=c.text;el.append(editor);editor.addEventListener('focus',()=>select(c.id));editor.addEventListener('input',()=>run(()=>{if(typing&&(typing.id!==c.id||typing.board!==board().id))flush();if(!typing)typing={board:board().id,id:c.id,before:board().cards.find(item=>item.id===c.id).text,text:editor.value};typing.text=editor.value;clearTimeout(typing.timer);typing.timer=setTimeout(()=>run(()=>{flush();refreshSelection()}),600)}));editor.addEventListener('blur',()=>run(flush))}
    else if(['image','video'].includes(c.type))mediaContent(el,c)
    for(const side of ['in','out']){
      const port=document.createElement('button');port.type='button';port.className='board-port is-'+side;port.dataset.side=side==='in'?'left':'right';port.setAttribute('aria-label',(side==='out'?'Connect from ':'Connect to ')+c.id);el.append(port)
      const pick=()=>run(()=>{if(suppressPortClick)return;if(linkSource)connect(linkSource.id,c.id,linkSource.side,port.dataset.side);else{linkSource={id:c.id,side:port.dataset.side};select(c.id);port.classList.add('is-connecting');announce('Source selected. Tap a dot on another card.')}})
      onActivate(port,pick)
      port.addEventListener('pointerdown',e=>{e.stopPropagation();if(e.button!==0)return;drag={kind:'link',id:c.id,side:port.dataset.side,start:{x:e.clientX,y:e.clientY},pointer:e.pointerId};port.setPointerCapture(e.pointerId)})
      port.addEventListener('pointermove',e=>{if(drag?.kind!=='link'||drag.pointer!==e.pointerId)return;if(Math.hypot(e.clientX-drag.start.x,e.clientY-drag.start.y)>8)drag.moved=true})
      port.addEventListener('pointerup',e=>{if(drag?.kind!=='link'||drag.pointer!==e.pointerId)return;const old=drag;drag=null;if(!old.moved)return;suppressPortClick=true;setTimeout(()=>suppressPortClick=false,500);const hit=document.elementFromPoint(e.clientX,e.clientY),target=hit?.closest('[data-card-id]'),port=hit?.closest('.board-port');if(target)run(()=>connect(old.id,target.dataset.cardId,old.side,port?.dataset.side||(old.side==='right'?'left':'right')));else announce('Drag onto another card to connect.');linkSource=null})
      port.addEventListener('pointercancel',()=>{drag=null;linkSource=null})
    }

    const resize=document.createElement('button');resize.className='board-card-resize';resize.type='button';resize.setAttribute('aria-label',`Resize ${c.type} card`);el.append(resize);resize.addEventListener('pointerdown',e=>{e.stopPropagation();e.preventDefault();run(()=>{flush();select(c.id);drag={kind:'resize',pointer:e.pointerId,start:point(e),cards:[clone(board().cards.find(item=>item.id===c.id))],board:board().id,preview:[]};resize.setPointerCapture(e.pointerId)})});resize.addEventListener('pointermove',moveDrag);resize.addEventListener('pointerup',endDrag);resize.addEventListener('pointercancel',cancelDrag);resize.addEventListener('keydown',e=>{const d={ArrowRight:[10,0],ArrowLeft:[-10,0],ArrowDown:[0,10],ArrowUp:[0,-10]}[e.key];if(d){e.preventDefault();run(()=>edit(b=>{const card=b.cards.find(item=>item.id===c.id);card.width=Math.max(120,Math.min(2000,card.width+d[0]));card.height=Math.max(120,Math.min(2000,card.height+d[1]))}))}})
    }
    Object.assign(el.style,{left:`${c.x}px`,top:`${c.y}px`,width:`${c.width}px`,height:`${c.height}px`,zIndex:c.type==='group'?'0':'2'});cardResize.observe(el);el.classList.toggle('is-group',c.type==='group');el.classList.toggle('is-selected',selection.has(c.id));el.querySelector('.board-card-grip').textContent=`⋮⋮  ${c.title||(c.type==='text'?'Text':c.type==='group'||c.type==='data'?c.title:c.name)}`;const editor=el.querySelector('textarea');if(editor){editor.readOnly=!!c.agentTurn&&jobs.has(c.agentTurn);if(document.activeElement!==editor||editor.readOnly)editor.value=c.text}if(c.type==='data')dataContent(el,c);updateStatus(c,el)
  }
  function render(){const ids=new Set(board().cards.map(c=>c.id));for(const id of els.keys())if(!ids.has(id))release(id);selection=new Set([...selection].filter(id=>ids.has(id)));displayCards().forEach(renderCard);name.textContent=board().name;refreshSelection()}
  function displayCards(){return board().cards.map(c=>{const preview=drag?.board===board().id?drag.preview?.find(p=>p.id===c.id):null;return preview?{...c,...preview}:c})}
  function moveDrag(e){if(!drag||!['cards','resize'].includes(drag.kind)||drag.pointer!==e.pointerId)return;const p=point(e);drag.preview=previewGeometry(drag.cards,drag.kind,p.x-drag.start.x,p.y-drag.start.y);displayCards().forEach(renderCard);drawEdges();drawMap()}
  function endDrag(e){if(!drag||drag.pointer!==e.pointerId)return;const old=drag;drag=null;if(!['cards','resize'].includes(old.kind))return;const changed=old.preview;if(!changed.length||changed.every(c=>{const before=old.cards.find(item=>item.id===c.id);return c.x===before.x&&c.y===before.y&&c.width===before.width&&c.height===before.height})){render();return}run(()=>{flush();store.edit(b=>changed.forEach(c=>{const card=b.cards.find(item=>item.id===c.id);if(card)Object.assign(card,c)}),old.board);render()})}
  function cancelDrag(){drag=null;render()}
  function activate(){drag=null;marquee.hidden=true;selection.clear();selectedEdge=null;linkSource=null;for(const key of [...els.keys()])release(key);restoreView();render();closePanel()}
  function restoreView(){if(board().viewOrigin==='top-left'){const r=canvas.getBoundingClientRect();store.change(()=>{board().view.x-=r.width/2;board().view.y-=r.height/2;delete board().viewOrigin})}setView(board().view)}
  function switchBoard(id){flush();saveView();store.change(c=>c.active=id);activate()}
  function createCard(type,extra={}){return normalizeCard({id:uid('card'),type,x:clamp(-state.pan.x/state.zoom-130+(board().cards.length%8)*24),y:clamp(-state.pan.y/state.zoom-80+(board().cards.length%8)*24),...extra})}
  async function addMedia(file,type){if(busy)throw Error('Wait for current import');if(!validMedia(file,type))throw Error('Choose a supported image/video up to 100 MiB');const target=board().id,c=createCard(type,{mediaId:uid('media'),name:file.name.slice(0,256)});busy=true;let written=false;try{await checkMedia(file,type);await mediaFile('put',c.mediaId,file);written=true;store.edit(b=>b.cards.push(c),target);if(board().id===target){selection=new Set([c.id]);render()}}catch(e){if(written)await mediaFile('delete',c.mediaId);throw e}finally{busy=false}}
  function picker(accept,fn){const el=document.createElement('input');el.type='file';el.accept=accept;el.addEventListener('change',()=>{if(el.files?.[0])run(()=>fn(el.files[0]))});el.click()}
  function addMenu(){flush();openPanel('Add card');button.setAttribute('aria-expanded','true');makeButton('Text card',()=>{const c=createCard('text',{text:''});edit(b=>b.cards.push(c));select(c.id);closePanel();els.get(c.id).querySelector('textarea').focus()});makeButton('Image card',()=>{closePanel();picker('image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp',file=>addMedia(file,'image'))});makeButton('Video card',()=>{closePanel();picker('video/mp4,video/webm,video/ogg',file=>addMedia(file,'video'))});makeButton('Data card',()=>{const c=createCard('data',{nodeType:'data',title:'Data',data:{description:'Plugin content'}});edit(b=>b.cards.push(c));select(c.id);closePanel()})}
  function addAt(p){run(()=>{const c=createCard('text',{x:clamp(p.x-130),y:clamp(p.y-80),text:'',title:'New card'});edit(b=>b.cards.push(c));select(c.id);closePanel();els.get(c.id).querySelector('textarea').focus()})}
  installCanvasGestures({shell,canvas,layer,world,svg,point,getView:()=>({x:state.pan.x,y:state.pan.y,zoom:state.zoom}),setView,add:addAt,beginPinch:()=>{drag=null;marquee.hidden=true;linkSource=null;render()}})
  function removeSelection(){edit(b=>{removeCards(b,selection);if(selectedEdge)b.edges=b.edges.filter(e=>e.id!==selectedEdge)});selection.clear();selectedEdge=null;refreshSelection();closePanel()}
  function copy(){flush();clipboard=fragment(board(),selection)}
  function paste(){if(clipboard?.cards.length)edit(b=>selection=new Set(pasteFragment(b,clipboard)))}
  function duplicate(){copy();paste()}
  function group(){edit(b=>selection=new Set([groupCards(b,selection)]))}
  function ungroup(){edit(b=>ungroupCards(b,selection));selection.clear();refreshSelection()}
  function history(direction){flush();store.restore(direction);selection.clear();selectedEdge=null;render()}
  makeButton('Properties',cardProperties,actions);makeButton('Duplicate',duplicate,actions);makeButton('Group',group,actions);makeButton('Ungroup',ungroup,actions);makeButton('Delete',removeSelection,actions)
  function boardsMenu(anchor){flush();openPanel('Canvases',anchor);for(const b of store.collection.boards)makeButton(`${b.id===board().id?'✓ ':''}${b.name}`,()=>switchBoard(b.id));makeButton('New canvas',()=>{saveView();store.change(c=>{const b=emptyBoard();c.boards.push(b);c.active=b.id});activate()});const title=input(board().name,'Canvas name');title.maxLength=100;makeButton('Rename canvas',()=>{const value=title.value.trim();if(!value)throw Error('Enter canvas name');store.change(()=>board().name=value);render();closePanel()});makeButton('Duplicate canvas',()=>{saveView();const next=clone(board()),content=fragment(next,new Set(next.cards.map(c=>c.id)));next.id=uid('board');next.name=next.name.slice(0,85)+' (copy)';next.cards=[];next.edges=[];pasteFragment(next,content,0);store.change(c=>{c.boards.push(next);c.active=next.id});activate()});makeButton('Delete canvas…',()=>{openPanel('Delete this canvas?');makeButton('Confirm delete canvas',()=>{const old=board().id;store.change(c=>{c.boards=c.boards.filter(b=>b.id!==old);if(!c.boards.length)c.boards.push(emptyBoard());c.active=c.boards[0].id});store.histories.delete(old);activate()})})}
  function searchMenu(anchor){openPanel('Find cards',anchor);const q=input('','Search cards'),list=document.createElement('div');panel.append(list);const update=()=>{list.replaceChildren();for(const c of board().cards.filter(c=>`${c.text||''} ${c.name||''} ${c.title||''} ${c.nodeType||''}`.toLowerCase().includes(q.value.toLowerCase())).slice(0,30))makeButton((c.text||c.name||c.title||c.type).slice(0,60)||'Empty text',()=>{selection=new Set([c.id]);fit([c]);refreshSelection();closePanel()},list)};q.addEventListener('input',update);update();q.focus()}
  async function download(){flush();const blob=await exportBoard(clone(board())),filename=`${board().name.replace(/[^\w\u4e00-\u9fff-]/g,'_')}.canvas.json`;if(invoke){await invoke('canvas_export',{name:filename,bundle:await blob.text()})}else{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}closePanel()}
  function moreMenu(anchor){openPanel('Canvas tools',anchor);for(const[label,fn]of [['Undo',()=>history('undo')],['Redo',()=>history('redo')],['Copy cards',copy],['Paste cards',paste],['Duplicate',duplicate],['Group',group],['Ungroup',ungroup],['Delete selection',removeSelection],['Fit all',()=>fit()],['Reset view',()=>setView({x:0,y:0,zoom:1})],['Toggle minimap',()=>map.hidden=!map.hidden],['Export canvas',download],['Import canvas',()=>{flush();closePanel();picker('.json',async file=>{if(busy)throw Error('Wait for current import');saveView();busy=true;try{await importBoard(file,store);activate()}finally{busy=false}})}]])makeButton(label,fn)}
  button.setAttribute('aria-label','Add card');button.title='Add card';button.setAttribute('aria-haspopup','dialog');onActivate(button,()=>run(()=>{if(!panel.hidden&&panel.getAttribute('aria-label')==='Add card')closePanel();else addMenu()}))
  function enable(old,label,fn){const b=shell.querySelector(`.canvas-rail-button[aria-label="${old}"]`);if(!b)return;b.disabled=false;b.setAttribute('aria-label',label);b.title=label;onActivate(b,()=>run(()=>fn(b)));return b}
  const selectButton=enable('Select','Select cards',()=>{mode='select';selectButton.classList.add('is-active');handButton.classList.remove('is-active')})
  const handButton=enable('Hand','Pan canvas',()=>{mode='hand';handButton.classList.add('is-active');selectButton.classList.remove('is-active')})
  enable('Assets','Canvases',boardsMenu);enable('Search','Find cards',searchMenu);enable('Field','Fit all cards',()=>fit());enable('More tools','Canvas tools',moreMenu);enable('Techniques','Ask Agent',agentMenu)
  canvas.addEventListener('pointerdown',e=>run(()=>{if(e.button!==0)return;flush();closePanel();canvas.setPointerCapture(e.pointerId);const r=canvas.getBoundingClientRect();if(e.shiftKey&&mode==='select'){drag={kind:'marquee',point:point(e),x:e.clientX-r.left,y:e.clientY-r.top,selection:new Set(selection)};marquee.hidden=false}else{selection.clear();selectedEdge=null;linkSource=null;refreshSelection();drag={kind:'pan',x:e.clientX,y:e.clientY,pan:clone(state.pan)}}}))
  canvas.addEventListener('pointermove',e=>{if(drag?.kind==='pan'){state.pan={x:clamp(drag.pan.x+e.clientX-drag.x),y:clamp(drag.pan.y+e.clientY-drag.y)};syncView()}if(drag?.kind==='marquee'){const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,p=point(e);Object.assign(marquee.style,{left:`${Math.min(x,drag.x)}px`,top:`${Math.min(y,drag.y)}px`,width:`${Math.abs(x-drag.x)}px`,height:`${Math.abs(y-drag.y)}px`});selection=new Set(drag.selection);for(const c of board().cards)if(c.x>=Math.min(p.x,drag.point.x)&&c.y>=Math.min(p.y,drag.point.y)&&c.x+c.width<=Math.max(p.x,drag.point.x)&&c.y+c.height<=Math.max(p.y,drag.point.y))selection.add(c.id);refreshSelection()}})
  canvas.addEventListener('pointerup',()=>{drag=null;marquee.hidden=true});canvas.addEventListener('pointercancel',()=>{drag=null;marquee.hidden=true})
  const zoom=e=>{e.preventDefault();const p=point(e);state.zoom=Math.max(.1,Math.min(4,state.zoom*Math.exp(-e.deltaY*.0012)));const r=canvas.getBoundingClientRect();state.pan={x:clamp(e.clientX-r.left-r.width/2-p.x*state.zoom),y:clamp(e.clientY-r.top-r.height/2-p.y*state.zoom)};syncView()}
  canvas.addEventListener('wheel',zoom,{passive:false});layer.addEventListener('wheel',e=>{if(!e.target.closest('textarea,.board-media,.board-data'))zoom(e)},{passive:false});canvas.addEventListener('dragover',e=>e.preventDefault());canvas.addEventListener('drop',e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)run(()=>addMedia(f,f.type.startsWith('image/')?'image':'video'))})
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePanel();linkSource=null;selection.clear();selectedEdge=null;refreshSelection();return}if(e.target.closest('textarea,input,select,video'))return;const cmd=e.ctrlKey||e.metaKey,k=e.key.toLowerCase();if(cmd&&['a','c','v','d','g','z','y','f'].includes(k)){e.preventDefault();run(()=>{if(k==='a'){selection=new Set(board().cards.map(c=>c.id));refreshSelection()}if(k==='c')copy();if(k==='v')paste();if(k==='d')duplicate();if(k==='g')e.shiftKey?ungroup():group();if(k==='z')history(e.shiftKey?'redo':'undo');if(k==='y')history('redo');if(k==='f')searchMenu(button)})}if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();run(removeSelection)}})
  document.addEventListener('pointerdown',e=>{if(!panel.hidden&&!panel.contains(e.target)&&!e.target.closest('.canvas-rail,.board-link-hit,.board-link-label'))closePanel()});window.addEventListener('resize',()=>{syncView();closePanel()});window.addEventListener('pagehide',e=>{try{flush();saveView()}catch{}if(!e.persisted)for(const id of [...els.keys()])release(id)})
  const api={version:1,snapshot:()=>{flush();return{board:clone(board()),selection:[...selection],context:upstreamContext(board(),selection)}},apply:ops=>{edit(b=>applyOperations(b,ops));return api.snapshot()},registerType:(type,renderer)=>{if(!/^[a-z][\w.-]{0,79}$/.test(type)||typeof renderer!=='function')throw Error('Invalid renderer');renderers.set(type,renderer);render()},unregisterType:type=>{renderers.delete(type);render()}}
  window.OpenAuraCanvas=Object.freeze(api)
  if(listen&&invoke)listen('core://canvas-request',async e=>{
    const requestId=e.payload?.requestId
    let request
    try{request=await invoke('canvas_take',{requestId})}catch{return}
    let response
    try{response={ok:true,result:request.action==='snapshot'?api.snapshot():api.apply(request.operations)}}catch(e){response={ok:false,error:e.message}}
    await invoke('canvas_reply',{requestId,response}).catch(e=>showError(String(e)))
  }).catch(e=>showError(`Canvas bridge: ${e}`))
  async function agentMenu(anchor) {
    flush();openPanel('Ask Agent',anchor)
    if(!invoke){const p=document.createElement('p');p.textContent='Agent calls are available in the OpenAura desktop app.';panel.append(p);return}
    const select=document.createElement('select');select.setAttribute('aria-label','Agent');panel.append(select)
    const providers=await invoke('canvas_agent',{action:'agents',payload:{}})
    for(const provider of providers){const option=document.createElement('option');option.value=provider.id;option.textContent=provider.name;select.append(option)}
    const cwd=input('','Project folder'),prompt=document.createElement('textarea')
    prompt.placeholder='What should the Agent do with these cards?';prompt.setAttribute('aria-label','Agent request');prompt.maxLength=20000;panel.append(prompt)
    const preview=document.createElement('details'),summary=document.createElement('summary'),contextPreview=document.createElement('pre')
    summary.textContent=`${upstreamContext(board(),selection).length} selected/upstream cards`
    contextPreview.textContent=upstreamContext(board(),selection).map(c=>c.type==='text'?c.text:`${c.type}: ${c.name||c.title}`).join('\n\n');preview.append(summary,contextPreview);panel.append(preview)
    const notice=document.createElement('p');notice.textContent='Images attach; video and data cards provide metadata only.';panel.append(notice)
    const send=makeButton('Send to Agent',async()=>{
      if(send.disabled)return
      send.disabled=true
      try {
        flush();const target=board().id,sourceIds=[...selection],context=upstreamContext(board(),selection),attachments=[]
        const images=context.filter(c=>c.type==='image');if(images.length>8)throw Error('Select at most 8 images');let encodedSize=0
        for(const c of images){const blob=await mediaFile('get',c.mediaId);if(!validMedia(blob,'image'))throw Error(`Missing image: ${c.name}`);if(!['image/png','image/jpeg','image/webp','image/gif'].includes(blob.type)||blob.size>5250000)throw Error(`Agent image is unsupported or too large: ${c.name}`);const content=await blobData(blob);encodedSize+=content.length;if(content.length>7000000||encodedSize>12000000)throw Error('Agent images exceed 12 MB encoded total');attachments.push({kind:'image',name:c.name,content})}
        if(!prompt.value.trim())throw Error('Enter an Agent request')
        const text=[prompt.value.trim(),...context.map(c=>c.type==='text'?`[${c.id}] ${c.text}`:`[${c.id}] ${c.type}: ${c.name||c.title||''}${c.type==='data'?` ${JSON.stringify(c.data)}`:''}`)].join('\n\n')
        const turnId=uid('canvas'),card=createCard('text',{text:'Waiting for Agent…',agentTurn:turnId,work:{agent:select.value,turnId,source:'canvas'}})
        store.edit(b=>{b.cards.push(card);for(const source of sourceIds)b.edges.push({id:uid('edge'),source,target:card.id,label:'result'})},target)
        jobs.set(turnId,{board:target,card:card.id,provider:select.value,assets:0})
        try {const ack=await invoke('canvas_agent',{action:'send',payload:{turnId,boardId:target,cardId:card.id,agent:select.value,cwd:cwd.value,text,attachments}});if(ack.uncertain)showError('Agent acknowledgement timed out; the turn may still be running. Use Stop before retrying.')}
        catch(e){store.edit(b=>{const c=b.cards.find(c=>c.id===card.id);if(c){c.text=`Agent request failed: ${e}`;delete c.agentTurn}},target);jobs.delete(turnId);throw e}
        closePanel();render()
      } finally {send.disabled=false}
    })
    for(const[turn,job]of jobs)makeButton(`Stop ${job.provider}`,()=>invoke('canvas_agent',{action:'cancel',payload:{turnId:turn}}))
  }
  let polling=false
  async function poll(restore=false) {
    if(!invoke||polling||document.hidden||drag||(!restore&&!jobs.size&&!board().cards.some(c=>c.work?.source==='canvas')))return
    polling=true
    try {
      const snapshot=await invoke('canvas_agent',{action:'snapshot',payload:{}})
      if(!Array.isArray(snapshot))throw Error('Invalid Canvas Agent status');canvasAvailable=true;canvasStates.clear()
      for(const item of snapshot) {
        canvasStates.set(item.turnId,{status:item.done?(item.error?'failed':'completed'):'running',label:'Core Canvas Agent',activity:item.error||item.provider})
        const b=store.collection.boards.find(b=>b.id===item.boardId),c=b?.cards.find(c=>c.id===item.cardId)
        if(restore&&c?.agentTurn===item.turnId&&!jobs.has(item.turnId))jobs.set(item.turnId,{board:item.boardId,card:item.cardId,provider:item.provider,assets:c.processedAssets??b.cards.filter(c=>c.generatedFrom===item.turnId).length})
        const job=jobs.get(item.turnId);if(!job)continue
        // A deleted/undone result is never recreated by streaming updates.
        if(c?.agentTurn===item.turnId) {
          const suffix=item.done&&item.error?`\n\nError: ${item.error}`:''
          const text=(item.text||(!item.done?'Waiting for Agent…':'')).slice(0,LIMITS.text-suffix.length)+suffix
          if(c.text!==text)store.change(()=>c.text=text.slice(0,LIMITS.text))
          while(job.assets<item.assetCount) {
            let asset,blob
            try{asset=await invoke('canvas_agent',{action:'asset',payload:{turnId:item.turnId,index:job.assets}});const [header,encoded]=asset.data.split(',');blob=new Blob([Uint8Array.from(atob(encoded),v=>v.charCodeAt(0))],{type:header.slice(5,-7)});if(!validMedia(blob,asset.kind))throw Error('Generated asset is invalid');await checkMedia(blob,asset.kind)}
            catch(e){store.change(()=>{c.processedAssets=job.assets+1});job.assets++;showError(`Generated media could not be imported: ${e}`);continue}
            const card=normalizeCard({id:uid('card'),type:asset.kind,x:c.x+c.width+50,y:c.y+job.assets*30,mediaId:uid('media'),name:`Generated ${asset.kind} ${job.assets+1}`,generatedFrom:item.turnId})
            await mediaFile('put',card.mediaId,blob)
            try{store.edit(b=>{const result=b.cards.find(card=>card.id===job.card&&card.agentTurn===item.turnId);if(!result)throw Error('Result card no longer exists');b.cards.push(card);b.edges.push({id:uid('edge'),source:job.card,target:card.id,label:'generated'});result.processedAssets=job.assets+1},job.board)}catch(e){await mediaFile('delete',card.mediaId);throw e}
            job.assets++
          }
          if(item.done)store.change(()=>{delete c.agentTurn})
        }
        if(item.done){if(item.error)showError(`Agent ${job.provider}: ${item.error}`);jobs.delete(item.turnId)}
      }
      render()
    } catch(e){canvasAvailable=false;for(const c of displayCards()){const el=els.get(c.id);if(el)updateStatus(c,el)}showError(`Agent status: ${e}`)}finally{polling=false}
  }
  setInterval(()=>{poll();pollWork()},500);document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastWorkPoll=0;poll(true);pollWork()}});layer.hidden=false;canvas.setAttribute('aria-label','Canvas background. Double-click or double-tap to add. Drag to pan; Shift-drag to select; pinch or scroll to zoom.');restoreView();render();poll(true);pollWork()
}
