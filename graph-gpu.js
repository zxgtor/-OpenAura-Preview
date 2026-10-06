// The graph's light and surface pass. Labels and hit testing stay in the 2D overlay.
import { createBlondelPost } from './blondel-post.js'
const nodeShader = `
struct Orb { geometry: vec4f, color: vec4f }
@group(0) @binding(0) var<storage, read> orbs: array<Orb>;
@group(0) @binding(1) var<uniform> scene: vec4f;
struct Out { @builtin(position) position: vec4f, @location(0) local: vec2f,
  @location(1) color: vec4f, @location(2) focus: f32 }
@vertex fn vertex(@builtin(vertex_index) vertex_id: u32, @builtin(instance_index) instance_id: u32) -> Out {
  let corners = array<vec2f, 6>(vec2f(-1.,-1.),vec2f(1.,-1.),vec2f(-1.,1.),
    vec2f(-1.,1.),vec2f(1.,-1.),vec2f(1.,1.));
  let orb = orbs[instance_id];
  let local = corners[vertex_id];
  let pixel = orb.geometry.xy + local * orb.geometry.z * 2.8;
  var out: Out;
  out.position = vec4f(pixel.x / scene.x * 2. - 1., 1. - pixel.y / scene.y * 2., 0., 1.);
  out.local = local * 2.8;
  out.color = orb.color;
  out.focus = orb.geometry.w;
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let r = length(in.local);
  let inside = 1. - smoothstep(.97, 1.025, r);
  let z = sqrt(max(0., 1. - r*r));
  let normal = normalize(vec3f(in.local, z));
  let light = normalize(vec3f(-.45, -.58, .78));
  let diffuse = max(dot(normal, light), 0.);
  let reflected = reflect(-light, normal);
  let specular = pow(max(reflected.z, 0.), 36.) * 1.8;
  let fresnel = pow(1. - z, 2.4);
  let flow = sin(in.local.x*18. + scene.z*.46) * sin(in.local.y*22. - scene.z*.38) * .025;
  let hot_core = exp(-dot(in.local-vec2f(-.27,-.31),in.local-vec2f(-.27,-.31))*15.) * (1.5+in.focus*2.4);
  let material = in.color.rgb * (.3 + diffuse*1.15 + flow) + vec3f(specular+hot_core) + in.color.rgb*fresnel*.5;
  let angle = atan2(in.local.y, in.local.x);
  let fibers = .56 + .44*sin(angle*88. + sin(angle*17.)*2.4 + scene.z*.28);
  let irregular = sin(angle*37. + scene.z*.19)*.035;
  let corona = (1. - smoothstep(.015,.105,abs(r - 1.41 - irregular))) * fibers * (.18 + in.focus*.23);
  let inner_ring = (1. - smoothstep(.012,.042,abs(r-1.16))) * (.12 + in.focus*.14);
  let halo = exp(-r*r*1.35) * .11 + exp(-pow((r-1.02)*2.2,2.))*.07;
  let alpha = clamp((inside + corona + inner_ring + halo)*in.color.a,0.,1.);
  let lit = material*inside + in.color.rgb*(corona*1.45 + inner_ring + halo*1.3);
  return vec4f(lit / max(inside + corona + inner_ring + halo, .001) * (1. + in.focus*.58), alpha);
}`

const lineShader = `
struct Strand { ends: vec4f, sides: vec4f, color: vec4f, flow: vec4f }
@group(0) @binding(0) var<storage, read> strands: array<Strand>;
@group(0) @binding(1) var<uniform> scene: vec4f;
struct Out { @builtin(position) position: vec4f, @location(0) pixel: vec2f,
  @location(1) ends: vec4f, @location(2) color: vec4f, @location(3) flow: vec4f }
@vertex fn vertex(@builtin(vertex_index) vertex_id: u32, @builtin(instance_index) instance_id: u32) -> Out {
  let corners = array<vec2f,6>(vec2f(0.,-1.),vec2f(1.,-1.),vec2f(0.,1.),
    vec2f(0.,1.),vec2f(1.,-1.),vec2f(1.,1.));
  let strand = strands[instance_id];
  let corner = corners[vertex_id];
  let side = mix(strand.sides.xy,strand.sides.zw,corner.x);
  let pixel = mix(strand.ends.xy,strand.ends.zw,corner.x) + side*corner.y*12.;
  var out: Out;
  out.position = vec4f(pixel.x / scene.x * 2. - 1., 1. - pixel.y / scene.y * 2., 0., 1.);
  out.pixel = pixel; out.ends = strand.ends; out.color = strand.color; out.flow = strand.flow;
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let segment = in.ends.zw - in.ends.xy;
  let along = clamp(dot(in.pixel-in.ends.xy,segment)/max(dot(segment,segment),.001),0.,1.);
  let distance = length(in.pixel - mix(in.ends.xy,in.ends.zw,along));
  let progress = mix(in.flow.x,in.flow.y,along);
  let head = fract(scene.z*.13 + in.flow.z);
  let tail = head - .14;
  let pulse = select(0.,pow(clamp((progress-tail)/.14,0.,1.),2.),progress>=tail && progress<=head);
  let core = exp(-distance*distance*1.8);
  let bloom = exp(-distance*distance*.055);
  let base = in.color.a*(core*mix(.29,.82,in.flow.w) + bloom*mix(.04,.12,in.flow.w));
  let signal = pulse*(core*.85 + bloom*.22) * (.55 + in.flow.w*.45);
  let opacity = clamp(base+signal,0.,.95);
  let color = mix(in.color.rgb,vec3f(1.,.94,.79),pulse*.7);
  return vec4f(color*(1.+pulse*1.7),opacity);
}`

async function pipeline(device, source, format) {
  const module=device.createShaderModule({code:source})
  const errors=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error')
  if (errors.length) throw Error(errors.map(message=>`${message.lineNum}: ${message.message}`).join('; '))
  return device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},
    fragment:{module,entryPoint:'fragment',targets:[{format,blend:{
      color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},
      alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}
    }}]},primitive:{topology:'triangle-list'}})
}

function capacity(n) {let size=256;while(size<n)size*=2;return size}
function point(a,c,b,t) {const u=1-t;return {x:u*u*a.x+2*u*t*c.x+t*t*b.x,y:u*u*a.y+2*u*t*c.y+t*t*b.y}}
function side(a,c,b,t) {
  const dx=2*(1-t)*(c.x-a.x)+2*t*(b.x-c.x),dy=2*(1-t)*(c.y-a.y)+2*t*(b.y-c.y)
  const length=Math.hypot(dx,dy)||1
  return {x:-dy/length,y:dx/length}
}

export async function createGraphGpu(canvas) {
  if (!navigator.gpu) return null
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'})
  if (!adapter) return null
  const device=await adapter.requestDevice()
  const context=canvas.getContext('webgpu')
  if (!context) return null
  const format=navigator.gpu.getPreferredCanvasFormat()
  context.configure({device,format,alphaMode:'premultiplied'})
  device.pushErrorScope('validation')
  const [orbPipeline,strandPipeline,post]=await Promise.all([
    pipeline(device,nodeShader,'rgba16float'),pipeline(device,lineShader,'rgba16float'),
    createBlondelPost(device,format)])
  const initError=await device.popErrorScope()
  if (initError) throw Error(initError.message)
  const scene=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
  const buffers={orb:null,strand:null}
  const bindings={orb:null,strand:null}
  const pipelines={orb:orbPipeline,strand:strandPipeline}
  let active=true
  device.addEventListener('uncapturederror',event=>{active=false;canvas.hidden=true;canvas.dataset.error=event.error.message})
  device.lost.then(()=>{active=false;canvas.hidden=true})
  function upload(kind,data) {
    if (!data.length) return
    if (!buffers[kind] || buffers[kind].size<data.byteLength) {
      buffers[kind]?.destroy()
      buffers[kind]=device.createBuffer({size:capacity(data.byteLength),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST})
      bindings[kind]=device.createBindGroup({layout:pipelines[kind].getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:buffers[kind]}},{binding:1,resource:{buffer:scene}}]})
    }
    device.queue.writeBuffer(buffers[kind],0,data)
  }
  return {
    get active(){return active},
    render(width,height,dpr,time,nodes,edges) {
      if (!active || !width || !height) return
      const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr)
      if (canvas.width!==pixelWidth || canvas.height!==pixelHeight) {canvas.width=pixelWidth;canvas.height=pixelHeight}
      post.resize(pixelWidth,pixelHeight)
      device.queue.writeBuffer(scene,0,new Float32Array([width,height,time/1000,0]))
      const orbData=new Float32Array(nodes.length*8)
      nodes.forEach((n,i)=>orbData.set([n.x,n.y,n.radius,n.focus?1:0,...n.color,n.alpha],i*8))
      const strandData=[]
      for(const e of edges) {
        const dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,length=Math.hypot(dx,dy)
        const bend=Math.min(18,length*.09),control={x:(e.a.x+e.b.x)/2-dy/Math.max(1,length)*bend,
          y:(e.a.y+e.b.y)/2+dx/Math.max(1,length)*bend}
        const count=Math.max(4,Math.ceil(length/18))
        const drawn=Math.max(0,Math.min(1,e.draw??1))
        for(let i=0;i<count && i/count<drawn;i++) {
          const start=i/count,end=Math.min((i+1)/count,drawn)
          const a=point(e.a,control,e.b,start),b=point(e.a,control,e.b,end)
          const sa=side(e.a,control,e.b,start),sb=side(e.a,control,e.b,end)
          strandData.push(a.x,a.y,b.x,b.y,sa.x,sa.y,sb.x,sb.y,...e.color,e.alpha,start,end,e.phase,e.focus?1:0)
        }
      }
      const lines=new Float32Array(strandData)
      upload('orb',orbData);upload('strand',lines)
      const encoder=device.createCommandEncoder()
      const pass=encoder.beginRenderPass({colorAttachments:[{view:post.hdrView,
        clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]})
      if (lines.length) {pass.setPipeline(strandPipeline);pass.setBindGroup(0,bindings.strand);pass.draw(6,lines.length/16)}
      if (orbData.length) {pass.setPipeline(orbPipeline);pass.setBindGroup(0,bindings.orb);pass.draw(6,nodes.length)}
      pass.end()
      post.record(encoder,context.getCurrentTexture().createView())
      device.queue.submit([encoder.finish()])
    }
  }
}
