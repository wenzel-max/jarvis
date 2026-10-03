import * as THREE from './vendor/three.module.js';

// ---------------------------------------------------------------------------
// A esfera do Jarvis: luz âmbar sobre o vazio.
//   1. casca de partículas (e um miolo esparso)
//   2. traços de circuito que seguem a superfície, em quatro camadas
//   3. fios de luz em órbita (cometas) em anéis inclinados
//   4. o NÚCLEO no centro, como nos filmes: coração branco-quente, raios de luz até a casca,
//      anéis de giroscópio e uma íris de HUD (círculos tracejados que giram em sentidos opostos)
// Tudo roda em shader; nenhuma geometria é recriada por quadro.
// ---------------------------------------------------------------------------

const STATES = {
  //            giro   anéis  brilho  escala  pulso  tremor  núcleo
  idle:      { spin: 0.10, rings: 1.0, bright: 0.85, scale: 1.0,  pulse: 0, jitter: 0.0, core: 0.90 },
  listening: { spin: 0.05, rings: 0.6, bright: 1.00, scale: 0.9,  pulse: 1, jitter: 0.2, core: 1.20 },
  thinking:  { spin: 0.55, rings: 2.6, bright: 1.15, scale: 0.97, pulse: 0, jitter: 0.5, core: 1.35 },
  speaking:  { spin: 0.16, rings: 1.4, bright: 1.05, scale: 1.0,  pulse: 0, jitter: 0.0, core: 1.10 },
};

const GLSL_COMMON = /* glsl */ `
  uniform float uTime;
  uniform float uSpin;
  uniform float uAudio;
  uniform float uScale;
  uniform float uAssemble;
  uniform float uJitter;
  uniform float uPulse;
  uniform float uPointScale;
  uniform float uCamDist;

  mat2 rot2(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
          mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
          mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
  // mais perto da câmera = 0, mais longe = 1
  float depthOf(float viewZ) { return clamp((-viewZ - (uCamDist - 1.4)) / 2.8, 0.0, 1.0); }

  vec3 amber(float t) {
    vec3 copper = vec3(0.66, 0.31, 0.11);
    vec3 ember  = vec3(1.00, 0.60, 0.12);
    vec3 gold   = vec3(1.00, 0.82, 0.48);
    return mix(mix(copper, ember, smoothstep(0.0, 0.55, t)), gold, smoothstep(0.55, 1.0, t));
  }
`;

// ---- 1. núcleo de partículas ----------------------------------------------
const CORE_VERT = GLSL_COMMON + /* glsl */ `
  attribute float aSeed;
  attribute float aSize;
  varying float vSeed;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    float r = length(p);
    float shell = smoothstep(0.55, 0.95, r);

    // rotação diferencial por latitude: cada anel horizontal gira a uma velocidade
    // própria, o que desenha os redemoinhos sem tirar nenhum ponto da esfera.
    p.xz = rot2(uSpin * (0.6 + 0.8 * sin(p.y * 3.0 + r * 2.0))) * p.xz;

    float n = vnoise(p * 2.4 + vec3(0.0, uTime * 0.3, 0.0));
    float amp = 0.035 + uAudio * 0.34 + uJitter * 0.06;
    p += normalize(p) * (n - 0.5) * 2.0 * amp * shell;

    p *= uScale * (1.0 + uPulse * 0.035 * sin(uTime * 9.5));
    p *= mix(0.1 + aSeed * 0.9, 1.0, uAssemble);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPointScale / -mv.z * (1.0 + uAudio * 0.6);

    vSeed = aSeed;
    vAlpha = mix(0.35, 1.0, shell) * mix(1.0, 0.4, depthOf(mv.z)) * smoothstep(0.0, 0.6, uAssemble);
  }
`;
const CORE_FRAG = GLSL_COMMON + /* glsl */ `
  uniform float uBright;
  varying float vSeed;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    a *= a;
    gl_FragColor = vec4(amber(vSeed) * a * vAlpha * uBright * 1.35, a * vAlpha * uBright * 1.35);
  }
`;

// ---- 2. traços de circuito ---------------------------------------------------
const TRACE_VERT = GLSL_COMMON + /* glsl */ `
  attribute float aSeed;
  attribute float aLayer;
  varying float vSeed;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    float dir = mod(aLayer, 2.0) < 0.5 ? 1.0 : -1.0;
    p.xz = rot2(uSpin * dir * (0.5 + aLayer * 0.28)) * p.xz;

    float n = vnoise(p * 2.0 + uTime * 0.2);
    p += normalize(p) * (n - 0.5) * (0.02 + uAudio * 0.3 + uJitter * 0.05);
    p *= uScale * mix(0.1 + aSeed, 1.0, uAssemble);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float tw = 0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 2.4) + aSeed * 60.0);
    vSeed = aSeed;
    vAlpha = mix(0.12, 0.75, tw) * mix(1.0, 0.35, depthOf(mv.z)) * smoothstep(0.0, 0.6, uAssemble);
  }
`;
const TRACE_FRAG = GLSL_COMMON + /* glsl */ `
  uniform float uBright;
  varying float vSeed;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(amber(0.35 + vSeed * 0.65), vAlpha * uBright);
  }
`;

// ---- 3. fios de luz em órbita --------------------------------------------------
const RING_VERT = GLSL_COMMON + /* glsl */ `
  attribute float aT;
  uniform float uRingT;
  uniform float uRingSpeed;
  uniform float uRingPhase;
  uniform float uTail;
  varying float vI;
  varying float vAlpha;

  void main() {
    vec3 p = position * uScale * (1.0 + uAudio * 0.1) * mix(0.3, 1.0, uAssemble);
    float head = fract(uRingT * uRingSpeed + uRingPhase);
    float d = mod(head - aT + 1.0, 1.0);
    float inten = pow(clamp(1.0 - d / uTail, 0.0, 1.0), 2.4);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (1.2 + 5.0 * inten) * uPointScale / -mv.z * 0.35;

    vI = inten;
    vAlpha = mix(1.0, 0.4, depthOf(mv.z)) * smoothstep(0.2, 0.9, uAssemble);
  }
`;
const RING_FRAG = GLSL_COMMON + /* glsl */ `
  uniform float uBright;
  uniform float uBase;
  varying float vI;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float soft = smoothstep(0.5, 0.0, d);
    float a = (uBase + vI) * soft * vAlpha * uBright;
    gl_FragColor = vec4(amber(0.45 + vI * 0.55), a);
  }
`;

// ---- halo ao redor da casca -------------------------------------------------------
const HALO_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const HALO_FRAG = /* glsl */ `
  uniform float uBright;
  uniform float uAudio;
  uniform float uAssemble;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 4.4;
    float shell = exp(-pow((r - 0.98) / 0.3, 2.0)) * 0.16;
    float core = exp(-r * r * 0.9) * 0.05;
    float a = (shell + core) * uBright * (1.0 + uAudio * 1.2) * uAssemble;
    gl_FragColor = vec4(vec3(1.0, 0.6, 0.12) * a, a);
  }
`;

// ---- 4. o núcleo: raios, coração e íris ----------------------------------------------------
const NUCLEUS_SIZE = 2.2;   // lado do plano do coração, em unidades do mundo
const IRIS_SIZE = 2.4;      // lado do plano da íris

// raios: saem do coração e vão até a casca; um pulso de luz viaja por cada um
const SPOKE_VERT = GLSL_COMMON + /* glsl */ `
  attribute float aT;
  attribute float aSeed;
  uniform float uRingT;
  varying float vA;

  void main() {
    vec3 p = position;
    p.xz = rot2(-uSpin * 0.45) * p.xz;                  // gira ao contrário da casca
    p *= uScale * mix(0.2, 1.0, uAssemble) * (1.0 + uAudio * 0.05);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float travel = fract(uRingT * (1.4 + aSeed * 1.6) + aSeed * 11.0);   // posição do pulso ao longo do raio
    float pulse = exp(-pow((aT - travel) * 7.0, 2.0));
    float base = (0.17 + 0.15 * (1.0 - aT)) * (0.6 + 0.8 * aSeed);        // mais forte perto do coração
    vA = (base + pulse * (1.0 + uAudio * 1.2)) * mix(1.0, 0.45, depthOf(mv.z)) * smoothstep(0.3, 1.0, uAssemble);
  }
`;
const SPOKE_FRAG = GLSL_COMMON + /* glsl */ `
  uniform float uBright;
  uniform float uCore;
  varying float vA;
  void main() {
    gl_FragColor = vec4(amber(0.55 + vA * 0.45) * vA * uBright * (0.6 + 0.4 * uCore), 1.0);
  }
`;

const PLANE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// coração: ponto branco-quente, brilho, anel fino ("olho") e um clarão em cruz bem leve
const NUCLEUS_FRAG = GLSL_COMMON + /* glsl */ `
  uniform float uBright;
  uniform float uCore;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * ${NUCLEUS_SIZE.toFixed(2)};
    float r = length(p);
    float breath = 1.0 + 0.07 * sin(uTime * 1.6) + uAudio * 0.9 + uPulse * 0.05 * sin(uTime * 9.5);

    float hot  = exp(-pow(r / (0.085 * breath), 2.0));
    float glow = exp(-r * r / (0.03 * breath)) * 0.55 + exp(-r * r / (0.22 * breath)) * 0.22;
    float eye  = (1.0 - smoothstep(0.0, 0.012, abs(r - 0.16 * breath))) * 0.7;
    float flare = (exp(-abs(p.x) * 28.0) * exp(-abs(p.y) * 2.2) + exp(-abs(p.y) * 28.0) * exp(-abs(p.x) * 2.2)) * 0.22;

    float k = uCore * uBright * smoothstep(0.35, 1.0, uAssemble);
    vec3 col = amber(0.6) * (glow + eye + flare) + vec3(1.0, 0.93, 0.78) * hot * 1.5;
    gl_FragColor = vec4(col * k, 1.0);
  }
`;

// íris de HUD: círculos concêntricos, tracejados e com marcas de régua, girando em sentidos opostos
const IRIS_FRAG = GLSL_COMMON + /* glsl */ `
  uniform float uBright;
  uniform float uCore;
  varying vec2 vUv;

  float ring(float r, float r0, float w) { return 1.0 - smoothstep(0.0, w, abs(r - r0)); }
  float dashes(float ang, float n, float duty) {
    float s = fract(ang * n / 6.2831853);
    return smoothstep(0.0, 0.03, s) * (1.0 - smoothstep(duty, duty + 0.03, s));
  }

  void main() {
    vec2 p = (vUv - 0.5) * ${IRIS_SIZE.toFixed(2)};
    float r = length(p);
    float ang = atan(p.y, p.x);
    float t = uTime;

    float a = 0.0;
    a += ring(r, 0.31, 0.009) * dashes(ang + t * 0.32 + uSpin * 1.5, 14.0, 0.62) * 1.0;
    a += ring(r, 0.44, 0.005) * 0.55;
    a += ring(r, 0.58, 0.02) * dashes(ang - t * 0.20 - uSpin * 1.2, 90.0, 0.2) * 0.95;
    a += ring(r, 0.74, 0.006) * dashes(ang + t * 0.11, 36.0, 0.35) * 0.8;
    a += ring(r, 0.90, 0.005) * dashes(ang - t * 0.07, 6.0, 0.8) * 0.6;

    float k = uBright * (0.75 + 0.25 * uCore) * (1.0 + uAudio * 0.8) * 1.5 * smoothstep(0.3, 1.0, uAssemble);
    gl_FragColor = vec4(amber(0.4 + a * 0.5) * a * k, 1.0);
  }
`;

// ---- geradores de geometria ---------------------------------------------------------
function buildCore(count) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const onShell = Math.random() < 0.78;
    const r = onShell ? 0.9 + Math.random() * 0.1 : 0.3 + Math.pow(Math.random(), 0.7) * 0.58;
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(th), r * u, r * s * Math.sin(th)], i * 3);
    seed[i] = Math.random();
    size[i] = onShell ? 0.9 + Math.random() * 1.7 : 0.7 + Math.random() * 1.1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  return g;
}

function sph(theta, phi, r) {
  return [r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)];
}

/** Caminhos de circuito: andam sobre a superfície e viram 90° a cada trecho. */
function buildTraces(traceCount) {
  const radii = [1.0, 1.07, 1.16, 1.27];
  const pos = [];
  const seeds = [];
  const layers = [];
  for (let t = 0; t < traceCount; t++) {
    const layer = Math.floor(Math.random() * radii.length);
    const r = radii[layer] + (Math.random() - 0.5) * 0.02;
    let theta = Math.random() * Math.PI * 2;
    let phi = Math.acos(2 * Math.random() - 1);
    let horizontal = Math.random() < 0.5;
    const sign = Math.random() < 0.5 ? 1 : -1;
    const seed = Math.random();
    const steps = 2 + Math.floor(Math.random() * 4);
    for (let s = 0; s < steps; s++) {
      const len = 0.05 + Math.random() * 0.25;
      const sub = Math.max(2, Math.ceil(len / 0.04));
      const stepLen = len / sub;
      for (let k = 0; k < sub; k++) {
        const a = sph(theta, phi, r);
        if (horizontal) theta += (sign * stepLen) / Math.max(Math.sin(phi), 0.25);
        else phi = Math.min(Math.PI - 0.15, Math.max(0.15, phi + sign * stepLen));
        const b = sph(theta, phi, r);
        pos.push(...a, ...b);
        seeds.push(seed, seed);
        layers.push(layer, layer);
      }
      horizontal = !horizontal;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(seeds), 1));
  g.setAttribute('aLayer', new THREE.BufferAttribute(new Float32Array(layers), 1));
  return g;
}

/** Raios do núcleo: saem do coração em direções aleatórias e param em alturas diferentes. */
function buildSpokes(count) {
  const pos = new Float32Array(count * 6);
  const t = new Float32Array(count * 2);
  const seed = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const sq = Math.sqrt(1 - u * u);
    const d = [sq * Math.cos(th), u, sq * Math.sin(th)];
    const r0 = 0.14 + Math.random() * 0.05;
    const r1 = 0.5 + Math.pow(Math.random(), 0.6) * 0.5;
    pos.set([d[0] * r0, d[1] * r0, d[2] * r0, d[0] * r1, d[1] * r1, d[2] * r1], i * 6);
    t.set([0, 1], i * 2);
    seed.fill(Math.random(), i * 2, i * 2 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  return g;
}

function buildRingGeometry(radius, count) {
  const pos = new Float32Array(count * 3);
  const t = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pos.set([Math.cos(a) * radius, 0, Math.sin(a) * radius], i * 3);
    t[i] = i / count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  return g;
}

// ---- a classe --------------------------------------------------------------------------
export class Orb {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.motion = reducedMotion ? 0.25 : 1;
    this.state = 'idle';
    this.level = 0;           // nível de áudio (0..1) informado de fora
    this.onFrame = null;      // chamado antes de cada quadro, para atualizar `level`
    this._lvl = 0;
    this._spin = 0;
    this._ringT = 0;
    this._cur = { ...STATES.idle };
    this._ptr = { x: 0, y: 0 };
    this._ptrS = { x: 0, y: 0 };
    this._t0 = performance.now();
    this._last = this._t0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'low-power',
    });
    this.renderer.setClearColor(0x090604, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    this.root = new THREE.Group();
    this.root.position.y = 0.16;
    this.root.rotation.z = 0.28;
    this.scene.add(this.root);

    // uniformes compartilhados: mexer aqui atualiza todas as camadas
    this.u = {
      uTime: { value: 0 },
      uSpin: { value: 0 },
      uAudio: { value: 0 },
      uScale: { value: 1 },
      uAssemble: { value: 0 },
      uJitter: { value: 0 },
      uPulse: { value: 0 },
      uBright: { value: 0.85 },
      uCore: { value: 0.9 },
      uPointScale: { value: 20 },
      uCamDist: { value: 5.6 },
      uRingT: { value: 0 },
    };

    const additive = {
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    };

    this.core = new THREE.Points(
      buildCore(9000),
      new THREE.ShaderMaterial({ ...additive, uniforms: this.u, vertexShader: CORE_VERT, fragmentShader: CORE_FRAG }),
    );
    this.traces = new THREE.LineSegments(
      buildTraces(520),
      new THREE.ShaderMaterial({ ...additive, uniforms: this.u, vertexShader: TRACE_VERT, fragmentShader: TRACE_FRAG }),
    );
    this.root.add(this.core, this.traces);

    // fios em órbita: cada anel tem inclinação, velocidade e cauda próprias
    this.rings = [];
    const ringDefs = [
      // raio, normal da órbita, velocidade (sinal = sentido), fase, cauda
      // |normal.z| >= 0.4 garante que nenhum anel apareça de perfil, como um traço reto
      [1.06, [0.10, 0.55, 0.83], 1.0, 0.0, 0.42],
      [1.14, [0.60, 0.20, 0.77], -0.8, 0.3, 0.5],
      [1.22, [-0.55, 0.45, 0.70], 1.3, 0.55, 0.35],
      [1.30, [0.30, -0.60, 0.74], -1.1, 0.8, 0.45],
      [1.10, [-0.20, 0.80, 0.57], 0.9, 0.15, 0.3],
      [1.38, [0.90, 0.10, 0.42], -0.7, 0.65, 0.55],
      [1.18, [-0.70, -0.20, 0.69], 1.2, 0.4, 0.4],
      [1.46, [0.05, -0.35, 0.94], -0.6, 0.9, 0.5],
    ];
    const up = new THREE.Vector3(0, 1, 0);
    for (const [radius, normal, speed, phase, tail] of ringDefs) {
      const mat = new THREE.ShaderMaterial({
        ...additive,
        uniforms: {
          ...this.u,
          uRingSpeed: { value: speed },
          uRingPhase: { value: phase },
          uTail: { value: tail },
          uBase: { value: 0.07 },
        },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
      });
      const pts = new THREE.Points(buildRingGeometry(radius, 520), mat);
      const pivot = new THREE.Group();
      const base = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(...normal).normalize());
      pivot.quaternion.copy(base);
      pivot.userData = { base, ph: Math.random() * 6.28, f1: 0.08 + Math.random() * 0.08, f2: 0.07 + Math.random() * 0.08 };
      pivot.add(pts);
      this.root.add(pivot);
      this.rings.push(pivot);
    }
    // o núcleo: raios dentro do grupo (acompanham a inclinação e o mouse) ...
    this.spokes = new THREE.LineSegments(
      buildSpokes(90),
      new THREE.ShaderMaterial({ ...additive, uniforms: this.u, vertexShader: SPOKE_VERT, fragmentShader: SPOKE_FRAG }),
    );
    this.root.add(this.spokes);

    // ... e três anéis de giroscópio em volta do coração, bem mais visíveis que os de fora
    const gyroDefs = [
      [0.22, [0.0, 0.05, 1.0], 1.5, 0.0, 0.5],
      [0.34, [0.65, 0.1, 0.75], -1.2, 0.35, 0.45],
      [0.47, [-0.5, 0.6, 0.62], 1.0, 0.7, 0.5],
    ];
    for (const [radius, normal, speed, phase, tail] of gyroDefs) {
      const mat = new THREE.ShaderMaterial({
        ...additive,
        uniforms: { ...this.u, uRingSpeed: { value: speed }, uRingPhase: { value: phase }, uTail: { value: tail }, uBase: { value: 0.32 } },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
      });
      const pts = new THREE.Points(buildRingGeometry(radius, 360), mat);
      const pivot = new THREE.Group();
      const base = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(...normal).normalize());
      pivot.quaternion.copy(base);
      pivot.userData = { base, ph: Math.random() * 6.28, f1: 0.1 + Math.random() * 0.1, f2: 0.09 + Math.random() * 0.1 };
      pivot.add(pts);
      this.root.add(pivot);
      this.rings.push(pivot);
    }
    this._e = new THREE.Euler();
    this._q = new THREE.Quaternion();

    // halo (fica fora do grupo inclinado para sempre encarar a câmera)
    this.halo = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 4.4),
      new THREE.ShaderMaterial({ ...additive, uniforms: this.u, vertexShader: HALO_VERT, fragmentShader: HALO_FRAG }),
    );
    this.halo.position.y = this.root.position.y;
    this.halo.position.z = -0.5;
    this.scene.add(this.halo);

    this.iris = new THREE.Mesh(
      new THREE.PlaneGeometry(IRIS_SIZE, IRIS_SIZE),
      new THREE.ShaderMaterial({ ...additive, uniforms: this.u, vertexShader: PLANE_VERT, fragmentShader: IRIS_FRAG }),
    );
    this.nucleus = new THREE.Mesh(
      new THREE.PlaneGeometry(NUCLEUS_SIZE, NUCLEUS_SIZE),
      new THREE.ShaderMaterial({ ...additive, uniforms: this.u, vertexShader: PLANE_VERT, fragmentShader: NUCLEUS_FRAG }),
    );
    this.iris.position.set(0, this.root.position.y, 0);
    this.nucleus.position.set(0, this.root.position.y, 0.2);
    this.scene.add(this.iris, this.nucleus);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('pointermove', (e) => {
      this._ptr.x = (e.clientX / window.innerWidth) * 2 - 1;
      this._ptr.y = (e.clientY / window.innerHeight) * 2 - 1;
    });

    this.resize();
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  setState(name) {
    if (STATES[name]) this.state = name;
  }

  setLevel(v) {
    this.level = Math.max(0, Math.min(1, v || 0));
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // janelas estreitas: a esfera encolhe e sobe, abrindo espaço para o resto embaixo
    const narrow = w <= 980;
    const dist = 5.6 * (aspect < 1.25 ? Math.pow(1.25 / aspect, 0.6) : 1) * (narrow ? 1.5 : 1);
    this.root.position.y = narrow ? 0.3 : 0.16;
    this.halo.position.y = this.root.position.y;
    this.iris.position.y = this.root.position.y;
    this.nucleus.position.y = this.root.position.y;
    this.camera.position.set(0, 0, dist);
    this.camera.updateProjectionMatrix();
    this.u.uCamDist.value = dist;
    this.u.uPointScale.value = (this.renderer.domElement.height / 1080) * 22 * (dist / 5.6);
  }

  _loop(now) {
    this._raf = requestAnimationFrame((t) => this._loop(t));
    if (document.hidden) { this._last = now; return; }   // janela escondida na bandeja: não desenha nada

    // ocioso = 30 quadros/s para poupar CPU/GPU; ativo = 60
    const minDt = this.state === 'idle' ? 1000 / 30 : 1000 / 60;
    if (now - this._last < minDt - 1) return;
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;

    this.onFrame?.();
    this._update(dt, now);
    this.renderer.render(this.scene, this.camera);
  }

  _update(dt, now) {
    const target = STATES[this.state];
    const k = 1 - Math.exp(-dt * 2.5);
    for (const key of Object.keys(target)) this._cur[key] += (target[key] - this._cur[key]) * k;

    // áudio: ataque rápido, queda suave
    const ka = this.level > this._lvl ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 8);
    this._lvl += (this.level - this._lvl) * ka;

    this._spin += dt * this._cur.spin * this.motion;
    this._ringT += dt * this._cur.rings * this.motion * 0.15;

    const assemble = Math.min(1, (now - this._t0) / 2600);
    const eased = 1 - Math.pow(1 - assemble, 3);

    const u = this.u;
    u.uTime.value = (now - this._t0) / 1000;
    u.uSpin.value = this._spin;
    u.uRingT.value = this._ringT;
    u.uAudio.value = this._lvl;
    u.uScale.value = this._cur.scale;
    u.uJitter.value = this._cur.jitter;
    u.uPulse.value = this._cur.pulse;
    u.uBright.value = this._cur.bright * (1 + 0.25 * this._lvl);
    u.uCore.value = this._cur.core;
    u.uAssemble.value = eased;

    // as órbitas balançam de leve em torno da inclinação base
    const t = u.uTime.value * this.motion;
    for (const p of this.rings) {
      const d = p.userData;
      this._e.set(Math.sin(t * d.f1 + d.ph) * 0.12, 0, Math.cos(t * d.f2 + d.ph) * 0.12);
      this._q.setFromEuler(this._e);
      p.quaternion.copy(d.base).multiply(this._q);
    }

    // paralaxe suave com o mouse
    const ks = 1 - Math.exp(-dt * 3);
    this._ptrS.x += (this._ptr.x - this._ptrS.x) * ks;
    this._ptrS.y += (this._ptr.y - this._ptrS.y) * ks;
    this.root.rotation.x = this._ptrS.y * 0.1 * this.motion;
    this.root.rotation.y = this._ptrS.x * 0.15 * this.motion;
  }
}
