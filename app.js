import { createGraphGpu } from './graph-gpu.js'
import { mountBoard, onActivate } from './canvas-board.js'

const $ = id => document.getElementById(id)
const canvas = $('space'), ctx = canvas.getContext('2d', { alpha: true })
const demoMode = new URLSearchParams(location.search).has('demo')
let gpu = null
if (demoMode) {
  document.body.classList.remove('is-empty')
  createGraphGpu($('gpu-space')).then(renderer => {
    gpu = renderer
    $('gpu-space').hidden = !renderer
    if (renderer) $('renderer').textContent = 'WEBGPU'
  }).catch(error => {
    $('gpu-space').dataset.error=String(error)
    $('renderer').title=String(error)
    console.warn('Graph WebGPU unavailable; using 2D fallback',error)
  })
}
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const kindNames = { space: 'SPACE', project: 'PROJECT', task: 'WORK', knowledge: 'KNOWLEDGE', source: 'SOURCE', artifact: 'RESULT', run: 'EXECUTION', agent: 'AGENT', person: 'PERSON' }
const state = { graph: null, byId: new Map(), links: new Map(), focus: 'home', history: [], poses: new Map(), targets: new Map(), hover: null, pan: { x: 0, y: 0 }, zoom: 1, drag: null, time: 0, frame: 0, hit: [], size: { w: 0, h: 0 }, showDetail: false, transitionAt: 0, detailTimer: null, group: 'all' }

function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
function rgba(hex, a) { const [r,g,b] = rgb(hex); return `rgba(${r},${g},${b},${a})` }
function hash(text) { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295 }
function lerp(a,b,t) { return a + (b-a)*t }
function smooth(t) { const v=Math.max(0,Math.min(1,t));return v*v*(3-2*v) }
function neighbors(id) { return state.links.get(id) || [] }

function overviewLayout() {
  const targets = new Map([['home', { x:0, y:0, alpha:1, rank:0 }]])
  const projects = state.graph.nodes.filter(n => n.kind === 'space' && n.id !== 'home')
  projects.forEach((project, i) => {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / projects.length + (hash(project.id)-.5)*.19
    const distance = 252 + (hash(`${project.id}-distance`)-.5)*78
    const cx = Math.cos(angle) * distance, cy = Math.sin(angle) * distance
    targets.set(project.id, { x:cx, y:cy, alpha:1, rank:1 })
    const tasks = state.graph.nodes.filter(n => n.cluster === project.id && n.weight === 4)
    tasks.forEach((task,j) => {
      const spread = (j - (tasks.length-1)/2) * .28 + (hash(task.id)-.5)*.12
      const reach = 108 + hash(`${task.id}-reach`)*43
      const tx = cx + Math.cos(angle+spread)*reach
      const ty = cy + Math.sin(angle+spread)*reach
      targets.set(task.id, { x:tx, y:ty, alpha:.9, rank:2 })
      const leaves = state.graph.nodes.filter(n => n.id.startsWith(`${task.id}-`))
      leaves.forEach((leaf,k) => {
        const leafAngle = angle + spread + (k-1.5)*.64 + (hash(leaf.id)-.5)*.25
        const leafReach = 25 + hash(`${leaf.id}-reach`)*18
        targets.set(leaf.id, { x:tx+Math.cos(leafAngle)*leafReach, y:ty+Math.sin(leafAngle)*leafReach, alpha:.18, rank:3 })
      })
    })
  })
  state.graph.nodes.filter(n => n.kind === 'agent' || n.kind === 'person').forEach((n,i) => {
    const hub = targets.get('agents')
    const angle = i * Math.PI * 2 / 8
    targets.set(n.id,{x:hub.x+Math.cos(angle)*52,y:hub.y+Math.sin(angle)*52,alpha:.18,rank:3})
  })
  return targets
}

function focusedLayout(id) {
  const fan=state.group!=='all'
  const targets = new Map([[id, { x:fan?-250:0, y:0, alpha:1, rank:0 }]])
  const first = [...new Set(neighbors(id).map(x => x.id))]
    .filter(child=>state.group==='all'||state.byId.get(child)?.kind===state.group)
    .sort((a,b) => (state.byId.get(b)?.weight||0)-(state.byId.get(a)?.weight||0) || a.localeCompare(b))
  const firstCount = first.length
  first.forEach((child,i) => {
    const angle = -Math.PI/2 + i*Math.PI*2/firstCount + (hash(child)-.5)*.22
    const distance = 179 + hash(`${child}-distance`)*55
    targets.set(child, fan?{x:35,y:(i-(firstCount-1)/2)*122,alpha:1,rank:1,angle}
      :{ x:Math.cos(angle)*distance, y:Math.sin(angle)*distance, alpha:1, rank:1, angle })
  })
  first.forEach((parent,i) => {
    const candidates = [...new Set(neighbors(parent).map(x => x.id))]
      .filter(child => !targets.has(child))
      .sort((a,b) => (state.byId.get(b)?.weight||0)-(state.byId.get(a)?.weight||0) || a.localeCompare(b))
    const base = targets.get(parent).angle
    candidates.forEach((child,j) => {
      if (targets.has(child)) return
      const spread = candidates.length > 1 ? (j-(candidates.length-1)/2)*Math.min(.16,1.14/candidates.length) : 0
      const angle = base+spread+(hash(child)-.5)*.07
      const distance = 335 + hash(`${child}-distance`)*68
      const lane=targets.get(parent).y
      targets.set(child,fan?{x:285+(j%2)*45,y:lane+(j-(candidates.length-1)/2)*49,alpha:.78,rank:2}
        :{x:Math.cos(angle)*distance,y:Math.sin(angle)*distance,alpha:.78,rank:2})
    })
  })
  return targets
}

function renderCards(id) {
  const cards=$('relation-cards');cards.replaceChildren()
  cards.hidden=id==='home'
  if(id==='home')return
  const groups=new Map()
  for(const link of neighbors(id)) {
    const kind=state.byId.get(link.id)?.kind
    if(kind)groups.set(kind,(groups.get(kind)||0)+1)
  }
  const choices=[['all',neighbors(id).length],...[...groups].sort((a,b)=>b[1]-a[1]).slice(0,5)]
  choices.forEach(([kind,count],index)=>{
    const button=document.createElement('button');button.type='button';button.className='relation-card'
    button.classList.toggle('selected',kind===state.group)
    button.style.setProperty('--order',index)
    const value=document.createElement('strong');value.dataset.count=count;value.textContent=reduceMotion.matches?count:'0'
    const label=document.createElement('span');label.textContent=kind==='all'?'ALL LINKS':kindNames[kind]
    button.append(value,label)
    button.addEventListener('click',()=>{if(state.group===kind)return;state.group=kind;setFocus(id,false,true)})
    cards.append(button)
  })
}

function setFocus(id, remember = true, preserveGroup = false) {
  if (!state.byId.has(id)) return
  if (remember && state.focus !== id) state.history.push(state.focus)
  if (!preserveGroup) state.group='all'
  state.focus = id
  state.transitionAt=performance.now()
  state.targets = id === 'home' ? overviewLayout() : focusedLayout(id)
  for (const [key,target] of state.targets) {
    if (!state.poses.has(key)) {
      const parent = neighbors(key).find(n => state.poses.has(n.id))?.id
      const from = state.poses.get(parent) || state.poses.get(state.focus) || { x:0,y:0 }
      state.poses.set(key, { x:from.x, y:from.y, alpha:0 })
    }
    else if(!reduceMotion.matches && target.rank>0) state.poses.get(key).alpha=0
  }
  for (const [key,pose] of state.poses) if (!state.targets.has(key)) state.targets.set(key, { x:pose.x, y:pose.y, alpha:0, rank:4 })
  state.pan = { x:0,y:0 }; state.zoom = 1
  $('back').disabled = state.history.length === 0
  const n = state.byId.get(id)
  $('eyebrow').textContent = id === 'home' ? 'THE CONNECTED WORKSPACE' : kindNames[n.kind]
  $('view-title').textContent = id === 'home' ? 'Everything is connected.' : n.title
  $('view-subtitle').textContent = id === 'home' ? 'Explore the work, knowledge and people behind every result.' : n.summary
  document.body.classList.toggle('is-focused',id!=='home')
  renderCards(id)
  state.showDetail = id !== 'home'
  renderDetail(n)
  clearTimeout(state.detailTimer)
  $('detail').hidden=true
  if(state.showDetail) {
    if(reduceMotion.matches) $('detail').hidden=false
    else state.detailTimer=setTimeout(()=>{if(state.focus===id&&state.showDetail)$('detail').hidden=false},1350)
  }
  $('count').textContent = `${state.graph.nodes.length} NODES  ·  ${state.graph.edges.length} CONNECTIONS`
}

function renderDetail(n) {
  $('detail-kind').textContent = kindNames[n.kind]
  $('detail-title').textContent = n.title
  $('detail-summary').textContent = n.summary
  $('detail-status').textContent = n.status.toUpperCase()
  $('detail-count').textContent = `${neighbors(n.id).length} CONNECTIONS`
  const body=(state.graph.details[n.id] || '').trim()
  const distinct=body.startsWith(n.summary)?body.slice(n.summary.length).trim():body
  $('detail-body').textContent=distinct
  $('detail-body').hidden=!distinct
  $('detail-orb').style.background = `radial-gradient(circle at 35% 30%,#ffffffb8,${n.color} 25%,${rgba(n.color,.65)} 46%,#092221 72%)`
  $('detail-orb').style.boxShadow = `0 0 0 7px ${rgba(n.color,.09)},0 0 0 14px ${rgba(n.color,.045)},0 0 32px ${rgba(n.color,.55)}`
  const list = $('connections'); list.replaceChildren()
  const sortedConnections=[...neighbors(n.id)].sort((a,b) => (state.byId.get(b.id)?.weight||0)-(state.byId.get(a.id)?.weight||0))
  sortedConnections.slice(0,18).forEach(connection => {
    const other = state.byId.get(connection.id)
    const button = document.createElement('button')
    button.type = 'button'
    const dot = document.createElement('i'); dot.style.setProperty('--node-color',other.color)
    const text = document.createElement('span'); text.textContent = other.title
    const relation = document.createElement('small'); relation.textContent = `${connection.direction === 'out' ? '→' : '←'} ${connection.label}`
    text.append(relation); button.append(dot,text)
    button.addEventListener('click',()=>setFocus(other.id))
    list.append(button)
  })
}

function resize() {
  const r = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2)
  state.size = { w:r.width, h:r.height, dpr }
  canvas.width = Math.round(r.width*dpr); canvas.height = Math.round(r.height*dpr)
  ctx.setTransform(dpr,0,0,dpr,0,0)
}
new ResizeObserver(resize).observe(canvas)

function camera() {
  const {w,h} = state.size
  const available = state.showDetail && w > 700 ? w-325 : w
  const fit = state.focus === 'home' ? Math.min(available/980,(h-210)/800,1.05) : Math.min(available/850,(h-300)/850,1)
  return { x: available/2 + state.pan.x, y:h/2 + (state.focus==='home'?66:90) + state.pan.y, scale:Math.max(.2,fit)*state.zoom }
}

function nodeReveal(target,id,elapsed) {
  if(reduceMotion.matches)return 1
  const delay=target.rank===0?0:target.rank===1?470:target.rank===2?970:1390
  return smooth((elapsed-delay-hash(id)*230)/420)
}
function edgeReveal(e,elapsed) {
  if(reduceMotion.matches)return 1
  const rank=Math.max(state.targets.get(e.source)?.rank??4,state.targets.get(e.target)?.rank??4)
  const delay=rank<=1?190:rank===2?790:1240
  return smooth((elapsed-delay-hash(e.id)*280)/650)
}

function screen(p,c) { return { x:c.x+p.x*c.scale, y:c.y+p.y*c.scale } }
function path(a,b) {
  const dx=b.x-a.x,dy=b.y-a.y, bend=Math.min(18,Math.hypot(dx,dy)*.09)
  const mx=(a.x+b.x)/2-dy/Math.max(1,Math.hypot(dx,dy))*bend
  const my=(a.y+b.y)/2+dx/Math.max(1,Math.hypot(dx,dy))*bend
  ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(mx,my,b.x,b.y)
  return {mx,my}
}
function curvePoint(a,control,b,t) {
  const u=1-t
  return {x:u*u*a.x+2*u*t*control.mx+t*t*b.x,y:u*u*a.y+2*u*t*control.my+t*t*b.y}
}

const stars = Array.from({length:105},(_,i)=>({x:hash(`star-x-${i}`),y:hash(`star-y-${i}`),r:.35+hash(`star-r-${i}`)*1.1,p:hash(`star-p-${i}`)*6.28}))
function drawBackground(t) {
  const {w,h} = state.size
  for (const star of stars) {
    const alpha = .08+.18*(.5+.5*Math.sin(t*.00045+star.p))
    ctx.fillStyle=`rgba(176,230,225,${alpha})`;ctx.beginPath();ctx.arc(star.x*w,star.y*h,star.r,0,Math.PI*2);ctx.fill()
  }
}

function drawEdges(c,t) {
  const elapsed=t-state.transitionAt
  for (const e of state.graph.edges) {
    const pa=state.poses.get(e.source),pb=state.poses.get(e.target)
    const ta=state.targets.get(e.source),tb=state.targets.get(e.target)
    if (!pa || !pb || !ta?.alpha || !tb?.alpha) continue
    const draw=edgeReveal(e,elapsed)
    if(draw<=0)continue
    const a=screen(pa,c),b=screen(pb,c),alpha=Math.min(ta.alpha,tb.alpha)*draw
    if ((a.x< -80&&b.x< -80)||(a.x>state.size.w+80&&b.x>state.size.w+80)||(a.y< -80&&b.y< -80)||(a.y>state.size.h+80&&b.y>state.size.h+80)) continue
    const major = (state.targets.get(e.source)?.rank||3)<=1 || (state.targets.get(e.target)?.rank||3)<=1
    const focal = e.source === state.focus || e.target === state.focus
    const color = focal ? '#e2c58e' : state.byId.get(e.target)?.color || '#8ccdc1'
    ctx.beginPath();const control=path(a,b)
    if(draw<1){ctx.beginPath();ctx.moveTo(a.x,a.y);for(let i=1;i<=20;i++){const p=curvePoint(a,control,b,draw*i/20);ctx.lineTo(p.x,p.y)}}
    const grad=ctx.createLinearGradient(a.x,a.y,b.x,b.y)
    grad.addColorStop(0,rgba(color,(focal?.68:major?.33:.1)*alpha));grad.addColorStop(.52,rgba('#f9e9be',(focal?.8:major?.37:.08)*alpha));grad.addColorStop(1,rgba(color,(focal?.58:major?.32:.1)*alpha))
    ctx.strokeStyle=grad;ctx.lineWidth=focal?1.5:major?1.15:.7
    if (focal) {ctx.shadowColor=rgba(color,.62*alpha);ctx.shadowBlur=8}
    ctx.stroke();ctx.shadowBlur=0
    if (!reduceMotion.matches && (major || hash(e.id)>.78)) {
      const progress=Math.min(draw,(t*.00014+hash(e.id))%1)
      const tail=Math.max(0,progress-.16)
      const start=curvePoint(a,control,b,tail),head=curvePoint(a,control,b,progress)
      const streak=ctx.createLinearGradient(start.x,start.y,head.x,head.y)
      streak.addColorStop(0,rgba(color,0));streak.addColorStop(.64,rgba(color,.22*alpha));streak.addColorStop(1,rgba('#fff9df',.95*alpha))
      ctx.save();ctx.globalCompositeOperation='screen';ctx.beginPath()
      for (let i=0;i<=12;i++) {
        const point=curvePoint(a,control,b,tail+(progress-tail)*i/12)
        if (i===0) ctx.moveTo(point.x,point.y); else ctx.lineTo(point.x,point.y)
      }
      ctx.strokeStyle=streak;ctx.lineWidth=focal?2.7:1.7;ctx.shadowColor=color;ctx.shadowBlur=focal?18:12;ctx.stroke()
      const glow=ctx.createRadialGradient(head.x,head.y,0,head.x,head.y,focal?16:11)
      glow.addColorStop(0,rgba('#fffdf3',.9*alpha));glow.addColorStop(.17,rgba(color,.48*alpha));glow.addColorStop(1,rgba(color,0))
      ctx.fillStyle=glow;ctx.beginPath();ctx.arc(head.x,head.y,focal?16:11,0,Math.PI*2);ctx.fill()
      ctx.restore()
    }
  }
}

function drawNode(n,p,c,t) {
  const pos=screen(p,c), rank=state.targets.get(n.id)?.rank??4
  const focused=n.id===state.focus, hovered=n.id===state.hover
  const orbColor=n.color
  const base=focused?25:n.kind==='space'?14:n.kind==='task'||n.kind==='project'?8:n.kind==='agent'||n.kind==='person'?6:3.5
  const radius=Math.max(2.5,base*c.scale*(hovered?1.2:1))
  if (pos.x< -70||pos.x>state.size.w+70||pos.y< -70||pos.y>state.size.h+70) return
  const alpha=p.alpha
  if (!gpu?.active) {
  const halo=ctx.createRadialGradient(pos.x,pos.y,0,pos.x,pos.y,radius*4.2)
  halo.addColorStop(0,rgba(orbColor,(focused?.35:.18)*alpha));halo.addColorStop(.48,rgba(orbColor,.055*alpha));halo.addColorStop(1,rgba(orbColor,0))
  ctx.fillStyle=halo;ctx.beginPath();ctx.arc(pos.x,pos.y,radius*4.2,0,Math.PI*2);ctx.fill()
  if (radius>5) {
    const pulse=focused&&!reduceMotion.matches?Math.sin(t*.001)*.8:0
    for (const [offset,opacity,width] of [[3,.37,.9],[7,.17,.65]]) {
      if (radius<10 && offset>3) continue
      ctx.beginPath();ctx.arc(pos.x,pos.y,radius+offset+pulse,0,Math.PI*2)
      ctx.strokeStyle=rgba(orbColor,opacity*alpha);ctx.lineWidth=width;ctx.stroke()
    }
    ctx.beginPath();ctx.ellipse(pos.x+radius*.18,pos.y+radius*.35,radius*.9,radius*.32,-.46,0,Math.PI*2)
    ctx.fillStyle=`rgba(0,0,0,${.28*alpha})`;ctx.fill()
  }
  const rim=ctx.createRadialGradient(pos.x-radius*.28,pos.y-radius*.38,radius*.06,pos.x,pos.y,radius*1.2)
  rim.addColorStop(0,rgba('#fff7e9',.67*alpha));rim.addColorStop(.19,rgba(orbColor,.95*alpha));rim.addColorStop(.59,rgba(orbColor,.82*alpha));rim.addColorStop(.86,rgba('#14272d',.83*alpha));rim.addColorStop(1,rgba(orbColor,.75*alpha))
  ctx.fillStyle=rim;ctx.beginPath();ctx.arc(pos.x,pos.y,radius,0,Math.PI*2);ctx.fill()
  if (radius>6) {
    ctx.beginPath();ctx.arc(pos.x,pos.y,radius*.77,Math.PI*.13,Math.PI*1.73)
    ctx.strokeStyle=rgba('#fff9e9',.39*alpha);ctx.lineWidth=Math.max(.55,radius*.045);ctx.stroke()
    ctx.beginPath();ctx.arc(pos.x,pos.y,radius*.88,Math.PI*.92,Math.PI*1.94)
    ctx.strokeStyle=rgba(orbColor,.7*alpha);ctx.lineWidth=Math.max(.6,radius*.06);ctx.stroke()
    const glint=ctx.createRadialGradient(pos.x-radius*.37,pos.y-radius*.43,0,pos.x-radius*.37,pos.y-radius*.43,radius*.72)
    glint.addColorStop(0,rgba('#ffffff',.56*alpha));glint.addColorStop(1,rgba('#ffffff',0))
    ctx.fillStyle=glint;ctx.beginPath();ctx.arc(pos.x,pos.y,radius,0,Math.PI*2);ctx.fill()
    if (focused && radius>14) {
      for (let i=0;i<88;i++) {
        const angle=i*Math.PI/44
        const variation=hash(`${n.id}-fiber-${i}`)
        const inner=radius*(1.23+variation*.12),outer=radius*(1.4+variation*.23)
        ctx.beginPath();ctx.moveTo(pos.x+Math.cos(angle)*inner,pos.y+Math.sin(angle)*inner)
        ctx.lineTo(pos.x+Math.cos(angle)*outer,pos.y+Math.sin(angle)*outer)
        ctx.strokeStyle=rgba(orbColor,(.09+variation*.36)*alpha);ctx.lineWidth=.45;ctx.stroke()
      }
      ctx.beginPath();ctx.arc(pos.x,pos.y,radius*1.19,0,Math.PI*2)
      ctx.strokeStyle=rgba(orbColor,.2*alpha);ctx.lineWidth=.55;ctx.stroke()
    }
  }
  }
  if (focused || hovered || rank<=1) {
    ctx.textAlign='center';ctx.textBaseline='top'
    const size=focused?15:rank<=1?12:10
    ctx.font=`${focused?600:500} ${size}px "Segoe UI",sans-serif`
    ctx.fillStyle=`rgba(234,246,241,${.94*alpha})`
    ctx.shadowColor='#041111';ctx.shadowBlur=7
    const label=n.title.length>25?n.title.slice(0,24)+'…':n.title
    ctx.fillText(label,pos.x,pos.y+radius+12)
    ctx.shadowBlur=0
    if (focused) {ctx.font='600 9px "Segoe UI",sans-serif';ctx.fillStyle=rgba(n.color,.8*alpha);ctx.fillText(kindNames[n.kind],pos.x,pos.y+radius+31)}
  }
  state.hit.push({id:n.id,x:pos.x,y:pos.y,r:Math.max(radius+9,rank<=2?15:8),rank})
}

function frame(timestamp) {
  state.frame=requestAnimationFrame(frame)
  if (!state.graph || document.hidden || !state.size.w) return
  if (gpu && !gpu.active) {$('renderer').textContent='2D';gpu=null}
  const dt=Math.min(48,timestamp-(state.time||timestamp));state.time=timestamp
  const blend=reduceMotion.matches?1:1-Math.exp(-dt/250)
  const elapsed=timestamp-state.transitionAt
  if(!reduceMotion.matches) $('relation-cards').querySelectorAll('strong[data-count]').forEach((value,index)=>{
    value.textContent=Math.round(Number(value.dataset.count)*smooth((elapsed-560-index*110)/620))
  })
  for (const [id,target] of state.targets) {
    const p=state.poses.get(id);if(!p)continue
    p.x=lerp(p.x,target.x,blend);p.y=lerp(p.y,target.y,blend);p.alpha=lerp(p.alpha,target.alpha*nodeReveal(target,id,elapsed),blend)
    if(target.alpha===0&&p.alpha<.012){state.poses.delete(id);state.targets.delete(id)}
  }
  const {w,h}=state.size;ctx.clearRect(0,0,w,h)
  drawBackground(timestamp)
  const c=camera()
  state.hit=[]
  const visible=state.graph.nodes.filter(n=>state.poses.get(n.id)?.alpha>.025)
  visible.sort((a,b)=>(state.targets.get(b.id)?.rank??4)-(state.targets.get(a.id)?.rank??4))
  if (gpu?.active) {
    const nodes=visible.map(n=>{
      const p=state.poses.get(n.id),pos=screen(p,c),focused=n.id===state.focus
      const base=focused?25:n.kind==='space'?14:n.kind==='task'||n.kind==='project'?8:n.kind==='agent'||n.kind==='person'?6:3.5
      return {x:pos.x,y:pos.y,radius:Math.max(2.5,base*c.scale*(n.id===state.hover?1.2:1)),
        color:rgb(n.color).map(v=>v/255),alpha:p.alpha,focus:focused}
    })
    const edges=state.graph.edges.flatMap(e=>{
      const pa=state.poses.get(e.source),pb=state.poses.get(e.target)
      const ta=state.targets.get(e.source),tb=state.targets.get(e.target)
      if (!pa || !pb || !ta?.alpha || !tb?.alpha) return []
      const draw=edgeReveal(e,elapsed)
      if(draw<=0)return []
      const a=screen(pa,c),b=screen(pb,c),alpha=Math.min(ta.alpha,tb.alpha)
      if ((a.x< -80&&b.x< -80)||(a.x>w+80&&b.x>w+80)||(a.y< -80&&b.y< -80)||(a.y>h+80&&b.y>h+80)) return []
      const focus=e.source===state.focus||e.target===state.focus
      const color=focus?'#e2c58e':state.byId.get(e.target)?.color||'#8ccdc1'
      return [{a,b,color:rgb(color).map(v=>v/255),alpha:alpha*(focus?1:.6),phase:hash(e.id),focus,draw}]
    })
    try {gpu.render(w,h,state.size.dpr,reduceMotion.matches?0:timestamp,nodes,edges)}
    catch(error) {
      $('gpu-space').dataset.error=String(error)
      $('gpu-space').hidden=true
      $('renderer').textContent='2D'
      $('renderer').title=String(error)
      gpu=null
    }
  } else drawEdges(c,timestamp)
  for(const n of visible)drawNode(n,state.poses.get(n.id),c,timestamp)
}

function hit(x,y) {
  let best=null,score=Infinity
  for(const n of state.hit){const d=Math.hypot(x-n.x,y-n.y);if(d<n.r&&d-n.r<score){best=n;score=d-n.r}}
  return best?.id
}
canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);state.drag={x:e.clientX,y:e.clientY,px:state.pan.x,py:state.pan.y,moved:false,hit:hit(e.offsetX,e.offsetY)}})
canvas.addEventListener('pointermove',e=>{
  if(state.drag){const dx=e.clientX-state.drag.x,dy=e.clientY-state.drag.y;if(Math.hypot(dx,dy)>4)state.drag.moved=true;if(state.drag.moved)state.pan={x:state.drag.px+dx,y:state.drag.py+dy}}
  else{state.hover=hit(e.offsetX,e.offsetY);canvas.style.cursor=state.hover?'pointer':'grab'}
})
canvas.addEventListener('pointerup',e=>{if(state.drag&&!state.drag.moved&&state.drag.hit)setFocus(state.drag.hit);state.drag=null})
canvas.addEventListener('pointercancel',()=>{state.drag=null})
canvas.addEventListener('wheel',e=>{e.preventDefault();state.zoom=Math.max(.52,Math.min(2.5,state.zoom*Math.exp(-e.deltaY*.0012)))},{passive:false})
canvas.addEventListener('keydown',e=>{if(e.key==='Enter'&&state.hover)setFocus(state.hover);if(e.key==='ArrowLeft')state.pan.x+=40;if(e.key==='ArrowRight')state.pan.x-=40;if(e.key==='ArrowUp')state.pan.y+=40;if(e.key==='ArrowDown')state.pan.y-=40})

$('back').addEventListener('click',()=>{const id=state.history.pop();if(id)setFocus(id,false)})
$('overview').addEventListener('click',()=>setFocus('home'))
$('close-detail').addEventListener('click',()=>{clearTimeout(state.detailTimer);state.showDetail=false;$('detail').hidden=true})
$('zoom-in').addEventListener('click',()=>{state.zoom=Math.min(2.5,state.zoom*1.22)})
$('zoom-out').addEventListener('click',()=>{state.zoom=Math.max(.52,state.zoom/1.22)})
const search=$('search'),results=$('search-results')
function updateSearch(){
  const q=search.value.trim().toLowerCase();results.replaceChildren();results.hidden=!q||!state.graph
  if(!q||!state.graph)return
  state.graph.nodes.filter(n=>`${n.title} ${n.summary} ${n.kind}`.toLowerCase().includes(q)).slice(0,9).forEach(n=>{
    const b=document.createElement('button');b.type='button';b.textContent=n.title
    const small=document.createElement('small');small.textContent=`${kindNames[n.kind]} · ${state.byId.get(n.cluster)?.title||'Workspace'}`;b.append(small)
    b.addEventListener('click',()=>{setFocus(n.id);search.value='';results.hidden=true;search.blur()});results.append(b)
  })
  if(!results.children.length){const empty=document.createElement('button');empty.textContent='No matching nodes';empty.disabled=true;results.append(empty)}
}
search.addEventListener('input',updateSearch)
search.addEventListener('keydown',e=>{if(e.key==='Enter')results.querySelector('button:not(:disabled)')?.click();if(e.key==='Escape'){search.value='';results.hidden=true;search.blur()}})
document.addEventListener('keydown',e=>{if(!demoMode || e.target.closest('[contenteditable],input,select'))return;if(e.key==='/'&&document.activeElement!==search){e.preventDefault();search.focus()}else if(e.key==='Escape'&&document.activeElement!==search&&state.focus!=='home')setFocus('home')})

async function loadGraph(){
  try {
    const response=await fetch('demo.json')
    if(!response.ok)throw Error('Canvas demo data unavailable')
    const graph=await response.json()
    if(graph.schemaVersion!==1||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))throw Error('Unsupported graph data')
    state.graph=graph;state.byId=new Map(graph.nodes.map(n=>[n.id,n]));state.links=new Map(graph.nodes.map(n=>[n.id,[]]))
    for(const e of graph.edges){if(!state.byId.has(e.source)||!state.byId.has(e.target))continue;state.links.get(e.source).push({id:e.target,label:e.label,direction:'out'});state.links.get(e.target).push({id:e.source,label:e.label,direction:'in'})}
    setFocus('home',false)
    state.frame=requestAnimationFrame(frame)
  } catch(error) {$('error').textContent=`Graph could not be loaded: ${error.message||error}`;$('error').hidden=false}
}
if (demoMode) loadGraph()
document.getElementById('close-window').addEventListener('click',()=>window.__TAURI__?.core?.invoke('hide_window'))
document.getElementById('canvas-resize').addEventListener('pointerdown',event=>{
  if (event.button!==0) return
  event.preventDefault()
  const resize=window.__TAURI__?.core?.invoke('canvas_resize',{direction:'se'})
  resize?.catch(error=>console.error('Canvas resize failed',error))
})

if (!demoMode) {
  const backgroundKey='openaura.infinite-canvas.background.v1'
  const borderKey='openaura.infinite-canvas.border.v1'
  const positionKey='openaura.infinite-canvas.toolbar-position.v1'
  const shell=document.querySelector('.shell')
  const rail=document.querySelector('.canvas-rail')
  const dragHandle=$('canvas-toolbar-drag')
  const backgroundButton=$('canvas-background-button')
  const backgroundMenu=$('canvas-background-menu')
  const customBackground=$('canvas-custom-background')
  mountBoard(shell)
  const customBorder=$('canvas-custom-border')
  const backgroundPresets=[...backgroundMenu.querySelectorAll('[data-canvas-background]')]
  const borderPresets=[...backgroundMenu.querySelectorAll('[data-canvas-border]')]
  const positionPresets=[...backgroundMenu.querySelectorAll('[data-toolbar-position]')]
  const validBackground=value=>value==='transparent'||/^#[0-9a-f]{6}$/i.test(value)
  const validBorder=value=>value==='subtle'||value==='light'||value==='none'||/^#[0-9a-f]{6}$/i.test(value)
  function setBackground(value) {
    if (!validBackground(value)) return
    shell.style.setProperty('--canvas-background',value)
    backgroundPresets.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.canvasBackground===value)))
    backgroundMenu.querySelector('.canvas-background-custom').classList.toggle('is-selected',value!=='transparent'&&!backgroundPresets.some(button=>button.dataset.canvasBackground===value))
    if (value!=='transparent') customBackground.value=value
    try { localStorage.setItem(backgroundKey,value) } catch {}
  }
  function setBorder(value) {
    if (!validBorder(value)) return
    shell.classList.toggle('has-light-edge',value==='light')
    if (value==='subtle'||value==='light') {
      shell.style.removeProperty('--canvas-border-color')
      shell.style.removeProperty('--canvas-border-highlight')
    } else {
      shell.style.setProperty('--canvas-border-color',value==='none'?'transparent':value)
      shell.style.setProperty('--canvas-border-highlight','transparent')
    }
    borderPresets.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.canvasBorder===value)))
    backgroundMenu.querySelector('.canvas-border-custom').classList.toggle('is-selected',value.startsWith('#')&&!borderPresets.some(button=>button.dataset.canvasBorder===value))
    if (value.startsWith('#')) customBorder.value=value
    try { localStorage.setItem(borderKey,value) } catch {}
  }
  function setPosition(value) {
    if (!['left','top','bottom','right'].includes(value)) return
    shell.dataset.toolbarPosition=value
    positionPresets.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.toolbarPosition===value)))
    try { localStorage.setItem(positionKey,value) } catch {}
  }
  let drag=null
  function clearDrag() {
    drag=null
    rail.classList.remove('is-dragging')
    for (const property of ['left','top','right','bottom','transform']) rail.style.removeProperty(property)
  }
  dragHandle.addEventListener('pointerdown',event=>{
    if (event.button!==0) return
    event.preventDefault()
    closeBackgroundMenu()
    const rect=rail.getBoundingClientRect()
    const surface=shell.getBoundingClientRect()
    drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,left:rect.left-surface.left,top:rect.top-surface.top,width:rect.width,height:rect.height,moved:false}
    dragHandle.setPointerCapture(event.pointerId)
  })
  dragHandle.addEventListener('pointermove',event=>{
    if (!drag||event.pointerId!==drag.id) return
    const dx=event.clientX-drag.startX
    const dy=event.clientY-drag.startY
    if (!drag.moved&&Math.hypot(dx,dy)<5) return
    drag.moved=true
    rail.classList.add('is-dragging')
    rail.style.left=`${Math.max(8,Math.min(shell.clientWidth-drag.width-8,drag.left+dx))}px`
    rail.style.top=`${Math.max(8,Math.min(shell.clientHeight-drag.height-8,drag.top+dy))}px`
    rail.style.right='auto'
    rail.style.bottom='auto'
    rail.style.transform='none'
  })
  dragHandle.addEventListener('pointerup',event=>{
    if (!drag||event.pointerId!==drag.id) return
    const moved=drag.moved
    const rect=rail.getBoundingClientRect()
    const surface=shell.getBoundingClientRect()
    clearDrag()
    if (!moved) return
    const x=rect.left+rect.width/2-surface.left
    const y=rect.top+rect.height/2-surface.top
    const edges={left:x,right:surface.width-x,top:y,bottom:surface.height-y}
    setPosition(Object.keys(edges).reduce((nearest,edge)=>edges[edge]<edges[nearest]?edge:nearest,'left'))
  })
  dragHandle.addEventListener('pointercancel',clearDrag)
  dragHandle.addEventListener('keydown',event=>{
    const positions={ArrowLeft:'left',ArrowUp:'top',ArrowDown:'bottom',ArrowRight:'right'}
    if (!positions[event.key]) return
    event.preventDefault()
    setPosition(positions[event.key])
  })
  function positionBackgroundMenu() {
    const anchor=backgroundButton.getBoundingClientRect()
    const surface=shell.getBoundingClientRect()
    const menu=backgroundMenu.getBoundingClientRect()
    backgroundMenu.style.left=`${Math.max(8,Math.min(anchor.right-surface.left+8,surface.width-menu.width-8))}px`
    backgroundMenu.style.top=`${Math.max(8,Math.min(anchor.top-surface.top-12,surface.height-menu.height-8))}px`
  }
  function closeBackgroundMenu() {
    backgroundMenu.hidden=true
    backgroundButton.setAttribute('aria-expanded','false')
  }
  let savedBackground='transparent'
  try { savedBackground=localStorage.getItem(backgroundKey)||'transparent' } catch {}
  setBackground(validBackground(savedBackground)?savedBackground:'transparent')
  let savedBorder='subtle'
  try { savedBorder=localStorage.getItem(borderKey)||'subtle' } catch {}
  setBorder(validBorder(savedBorder)?savedBorder:'subtle')
  let savedPosition='left'
  try { savedPosition=localStorage.getItem(positionKey)||'left' } catch {}
  setPosition(savedPosition)
  onActivate(backgroundButton,()=>{
    const open=backgroundMenu.hidden
    backgroundMenu.hidden=!open
    backgroundButton.setAttribute('aria-expanded',String(open))
    if (open) positionBackgroundMenu()
  })
  for (const button of backgroundMenu.querySelectorAll('button')) onActivate(button,event=>{
    const choice=event.target.closest('[data-canvas-background]')
    const borderChoice=event.target.closest('[data-canvas-border]')
    const positionChoice=event.target.closest('[data-toolbar-position]')
    if (choice) setBackground(choice.dataset.canvasBackground)
    else if (borderChoice) setBorder(borderChoice.dataset.canvasBorder)
    else if (positionChoice) setPosition(positionChoice.dataset.toolbarPosition)
    else return
    closeBackgroundMenu()
  })
  customBackground.addEventListener('input',()=>setBackground(customBackground.value))
  customBorder.addEventListener('input',()=>setBorder(customBorder.value))
  document.addEventListener('pointerdown',event=>{
    if (!backgroundMenu.hidden&&!backgroundMenu.contains(event.target)&&!backgroundButton.contains(event.target)) closeBackgroundMenu()
  })
  document.addEventListener('keydown',event=>{
    if (event.key==='Escape'&&!backgroundMenu.hidden) { closeBackgroundMenu(); backgroundButton.focus() }
  })
  window.addEventListener('resize',()=>{if (!backgroundMenu.hidden) positionBackgroundMenu()})
}
