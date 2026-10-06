// Graph adapter for Blondel's dual-filter bloom and AgX post shaders.
// Source revision and adaptations are documented in ../README.md.
async function shader(device, url) {
  const response=await fetch(url)
  if (!response.ok) throw Error(`Could not load ${url}`)
  const module=device.createShaderModule({code:await response.text()})
  const errors=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error')
  if (errors.length) throw Error(errors.map(message=>`${message.lineNum}: ${message.message}`).join('; '))
  return module
}

function fullscreen(device,module,layout,entry,format,blend) {
  return device.createRenderPipeline({layout,vertex:{module,entryPoint:'vs_main'},
    fragment:{module,entryPoint:entry,targets:[{format, ...(blend?{blend}:{})}]},
    primitive:{topology:'triangle-list'}})
}

function passInto(encoder,target,pipeline,group,clear=true) {
  const pass=encoder.beginRenderPass({colorAttachments:[{view:target,
    clearValue:{r:0,g:0,b:0,a:0},loadOp:clear?'clear':'load',storeOp:'store'}]})
  pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end()
}

export async function createBlondelPost(device,outputFormat) {
  const [bloomShader,toneShader]=await Promise.all([
    shader(device,new URL('./blondel-bloom.wgsl',import.meta.url)),
    shader(device,new URL('./blondel-tonemap.wgsl',import.meta.url))])
  const sampleLayout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d'}},
    {binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}}]})
  const toneLayout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d'}},
    {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float',viewDimension:'2d'}},
    {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
    {binding:3,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}}]})
  const samplePipelineLayout=device.createPipelineLayout({bindGroupLayouts:[sampleLayout]})
  const tonePipelineLayout=device.createPipelineLayout({bindGroupLayouts:[toneLayout]})
  const downFirst=fullscreen(device,bloomShader,samplePipelineLayout,'fs_down_first','rgba16float')
  const down=fullscreen(device,bloomShader,samplePipelineLayout,'fs_down','rgba16float')
  const up=fullscreen(device,bloomShader,samplePipelineLayout,'fs_up','rgba16float',{
    color:{srcFactor:'one',dstFactor:'one',operation:'add'},
    alpha:{srcFactor:'zero',dstFactor:'one',operation:'add'}})
  const tone=fullscreen(device,toneShader,tonePipelineLayout,'fs_main',outputFormat)
  const sampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'})
  const params=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
  device.queue.writeBuffer(params,0,new Float32Array([1,.52,.1,0]))
  let hdr=null,bloom=null,hdrView=null,mips=[],downGroups=[],upGroups=[],toneGroup=null,width=0,height=0
  const sampled=view=>device.createBindGroup({layout:sampleLayout,entries:[
    {binding:0,resource:view},{binding:1,resource:sampler}]})
  return {
    get hdrView(){return hdrView},
    resize(nextWidth,nextHeight) {
      if (width===nextWidth && height===nextHeight) return
      width=nextWidth;height=nextHeight
      hdr?.destroy();bloom?.destroy()
      hdr=device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING})
      hdrView=hdr.createView()
      const bw=Math.max(1,Math.floor(width/2)),bh=Math.max(1,Math.floor(height/2))
      const count=Math.min(6,1+Math.floor(Math.log2(Math.min(bw,bh))))
      bloom=device.createTexture({size:[bw,bh],mipLevelCount:count,format:'rgba16float',
        usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING})
      mips=Array.from({length:count},(_,i)=>bloom.createView({baseMipLevel:i,mipLevelCount:1}))
      downGroups=[sampled(hdrView),...mips.slice(0,-1).map(sampled)]
      upGroups=mips.slice(1).map(sampled)
      toneGroup=device.createBindGroup({layout:toneLayout,entries:[
        {binding:0,resource:hdrView},{binding:1,resource:mips[0]},
        {binding:2,resource:sampler},{binding:3,resource:{buffer:params}}]})
    },
    record(encoder,outputView) {
      for(let i=0;i<mips.length;i++) passInto(encoder,mips[i],i===0?downFirst:down,downGroups[i])
      for(let i=mips.length-2;i>=0;i--) passInto(encoder,mips[i],up,upGroups[i],false)
      passInto(encoder,outputView,tone,toneGroup)
    }
  }
}
