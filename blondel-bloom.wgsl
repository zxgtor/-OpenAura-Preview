// Dual-filter bloom (Marius Bjørge / Kawase style).
// fs_down_first applies a Karis average to suppress fireflies.

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
    var out: VsOut;
    let xy = vec2f(f32((vid << 1u) & 2u), f32(vid & 2u));
    out.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2f(xy.x, 1.0 - xy.y);
    return out;
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

/// NaN/Inf 消毒：单个坏纹素会顺着整条泛光链扩散成一团黑斑。
fn sane(c_in: vec3f) -> vec3f {
    let c = select(vec3f(0.0), c_in, c_in == c_in);
    return min(c, vec3f(30000.0));
}

/// Karis 权重：亮度越高权重越低，用来压 firefly。
///
/// **它是权重，不是对颜色的变换。** 之前这里写成 `return c / (1 + luma)` 并把结果
/// 直接累加再除以固定的 8——那等于对每个样本做了一次色调压缩：暗部（luma 0.05）
/// 通过率 95%，高光（luma 20）只剩 5%。整条链里几乎没有高光能量、全是中暗调，
/// 加回画面就是一层均匀白纱而不是亮处的光晕。
/// 正确形式是加权平均 Σ(cᵢ·wᵢ)/Σ(wᵢ)：量级不变，firefly 照样被压（单个极亮纹素
/// 的权重趋近 0），大片均匀的亮区则原样通过（权重都小但相等，平均值不变）。
fn karis_weight(c: vec3f) -> f32 {
    return 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722)));
}

@fragment
fn fs_down_first(in: VsOut) -> @location(0) vec4f {
    let texel = 1.0 / vec2f(textureDimensions(src));
    let h = texel * 0.5;
    let offs = array<vec2f, 5>(
        vec2f(0.0, 0.0),
        vec2f(-h.x, -h.y), vec2f(h.x, -h.y),
        vec2f(-h.x, h.y), vec2f(h.x, h.y),
    );
    let taps = array<f32, 5>(4.0, 1.0, 1.0, 1.0, 1.0);
    var sum = vec3f(0.0);
    var wsum = 0.0;
    for (var i = 0; i < 5; i++) {
        let c = sane(textureSampleLevel(src, samp, in.uv + offs[i], 0.0).rgb);
        let w = taps[i] * karis_weight(c);
        sum += c * w;
        wsum += w;
    }
    return vec4f(sum / max(wsum, 1e-6), 1.0);
}

@fragment
fn fs_down(in: VsOut) -> @location(0) vec4f {
    let texel = 1.0 / vec2f(textureDimensions(src));
    let h = texel * 0.5;
    var c = textureSampleLevel(src, samp, in.uv, 0.0).rgb * 4.0;
    c += textureSampleLevel(src, samp, in.uv + vec2f(-h.x, -h.y), 0.0).rgb;
    c += textureSampleLevel(src, samp, in.uv + vec2f( h.x, -h.y), 0.0).rgb;
    c += textureSampleLevel(src, samp, in.uv + vec2f(-h.x,  h.y), 0.0).rgb;
    c += textureSampleLevel(src, samp, in.uv + vec2f( h.x,  h.y), 0.0).rgb;
    return vec4f(c / 8.0, 1.0);
}

@fragment
fn fs_up(in: VsOut) -> @location(0) vec4f {
    let texel = 1.0 / vec2f(textureDimensions(src));
    let h = texel;
    var c = vec3f(0.0);
    c += textureSampleLevel(src, samp, in.uv + vec2f(-h.x * 2.0, 0.0), 0.0).rgb;
    c += textureSampleLevel(src, samp, in.uv + vec2f( h.x * 2.0, 0.0), 0.0).rgb;
    c += textureSampleLevel(src, samp, in.uv + vec2f(0.0, -h.y * 2.0), 0.0).rgb;
    c += textureSampleLevel(src, samp, in.uv + vec2f(0.0,  h.y * 2.0), 0.0).rgb;
    c += textureSampleLevel(src, samp, in.uv + vec2f(-h.x,  h.y), 0.0).rgb * 2.0;
    c += textureSampleLevel(src, samp, in.uv + vec2f( h.x,  h.y), 0.0).rgb * 2.0;
    c += textureSampleLevel(src, samp, in.uv + vec2f(-h.x, -h.y), 0.0).rgb * 2.0;
    c += textureSampleLevel(src, samp, in.uv + vec2f( h.x, -h.y), 0.0).rgb * 2.0;
    return vec4f(c / 12.0, 1.0);
}
