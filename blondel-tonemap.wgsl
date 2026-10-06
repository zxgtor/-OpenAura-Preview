// Adapted from Blondel's tonemap.wgsl at 31b238932baeb6e6055ecb37fc02a276b9f02238.
// The graph has no depth, irradiance map, or 3D scene lighting. The AgX curve is
// retained; output stays display encoded for the WebGPU canvas's unorm format.
struct Params { data: vec4f } // exposure, bloom, vignette, unused
@group(0) @binding(0) var hdr_tex: texture_2d<f32>;
@group(0) @binding(1) var bloom_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: Params;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
  var out: VsOut;
  let xy = vec2f(f32((vid << 1u) & 2u), f32(vid & 2u));
  out.pos = vec4f(xy * 2. - 1., 0., 1.);
  out.uv = vec2f(xy.x, 1. - xy.y);
  return out;
}

const AGX_MIN_EV: f32 = -12.47393;
const AGX_MAX_EV: f32 = 4.026069;
fn agx_contrast(x: vec3f) -> vec3f {
  let x2 = x*x; let x4 = x2*x2;
  return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x
    + 0.4298*x2 + 0.1191*x - 0.00232;
}
fn agx_tonemap(color: vec3f) -> vec3f {
  let inset = mat3x3f(
    vec3f(0.842479062253094,0.0423282422610123,0.0423756549057051),
    vec3f(0.0784336,0.878468636469772,0.0784336),
    vec3f(0.0792237451477643,0.0791661274605434,0.879142973793104));
  let outset = mat3x3f(
    vec3f(1.19687900512017,-0.0528968517574562,-0.0529716355144438),
    vec3f(-0.0980208811401368,1.15190312990417,-0.0980434501171241),
    vec3f(-0.0990297440797205,-0.0989611768448433,1.15107367264116));
  var v = inset*max(color,vec3f(0.));
  v = clamp(log2(max(v,vec3f(1e-10))),vec3f(AGX_MIN_EV),vec3f(AGX_MAX_EV));
  v = (v-AGX_MIN_EV)/(AGX_MAX_EV-AGX_MIN_EV);
  v = agx_contrast(v);
  let punch = pow(max(v,vec3f(0.)),vec3f(1.12));
  let l = dot(punch,vec3f(.2126,.7152,.0722));
  v = mix(v,vec3f(l)+(punch-vec3f(l))*1.25,.35);
  return clamp(outset*v,vec3f(0.),vec3f(1.));
}

@fragment fn fs_main(in: VsOut) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(hdr_tex));
  let pixel = clamp(vec2i(in.uv*vec2f(dims)),vec2i(0),dims-1);
  let hdr = textureLoad(hdr_tex,pixel,0);
  let bloom = textureSampleLevel(bloom_tex,samp,in.uv,0.).rgb;
  // The HDR attachment stores premultiplied color after alpha blending.
  let light = min(select(vec3f(0.),hdr.rgb,hdr.rgb==hdr.rgb),vec3f(30000.));
  let haze = min(select(vec3f(0.),bloom,bloom==bloom),vec3f(30000.));
  let surface = agx_tonemap(light/max(hdr.a,0.0001)*params.data.x);
  let glow = agx_tonemap(haze*params.data.y*params.data.x);
  let surface_luma = dot(surface,vec3f(.2126,.7152,.0722));
  let glow_luma = dot(glow,vec3f(.2126,.7152,.0722));
  let surface_color = clamp(vec3f(surface_luma)+(surface-vec3f(surface_luma))*1.32,vec3f(0.),vec3f(1.));
  let glow_color = clamp(vec3f(glow_luma)+(glow-vec3f(glow_luma))*1.32,vec3f(0.),vec3f(1.));
  let surface_alpha = clamp(hdr.a,0.,1.);
  let glow_alpha = clamp(glow_luma*.8,0.,.55)*(1.-surface_alpha);
  var color = surface_color*surface_alpha+glow_color*glow_alpha;
  let d = in.uv-.5;
  color *= clamp(1.-dot(d,d)*params.data.z,0.,1.);
  return vec4f(color,surface_alpha+glow_alpha);
}
