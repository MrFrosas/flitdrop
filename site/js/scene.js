// Flitdrop 3D film. Procedural phone + laptop, live screen textures, an encrypted
// packet that flies between them. The whole thing is a pure function of scroll p in [0,1],
// so it reverses cleanly. No external assets. Vendored three@0.185 (ESM) + two addons.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer, RenderPass, EffectPass, BloomEffect } from 'postprocessing';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

let readyResolve;
window.flitSceneReady = new Promise((r) => { readyResolve = r; });

const T = (k) => (window.FDI18N ? window.FDI18N.t(k) : k);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
// normalized progress of p across [a,b]
const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
const clampF = (v) => Math.max(0, Math.min(1, v));
const FONT = '-apple-system, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const PHOTO_GRADS = [
  ['#ff9a56', '#ff5e8a'], ['#f9d423', '#ff4e50'], ['#3a7bd5', '#00d2ff'],
  ['#b06ab3', '#4568dc'], ['#11998e', '#38ef7d'], ['#ee9ca7', '#ffdde1'],
  ['#2193b0', '#6dd5ed'], ['#c94b4b', '#4b134f'], ['#0f2027', '#2c5364'],
];
const BLUE = '#1e7bff';      // brand blue, flat
const CYAN = '#42c8ff';      // logo cyan, accents/glow only
let GRID_IMG = [];           // real photos, populated in build()

// draw an image cover-fitted inside a rounded rect
function drawImgRounded(ctx, img, x, y, w, h, r) {
  ctx.save();
  rr(ctx, x, y, w, h, r); ctx.clip();
  const ir = img.naturalWidth / img.naturalHeight, br = w / h;
  let dw = w, dh = h, dx = x, dy = y;
  if (ir > br) { dw = h * ir; dx = x - (dw - w) / 2; } else { dh = w / ir; dy = y - (dh - h) / 2; }
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}
function imgReady(im) { return im && im.complete && im.naturalWidth > 0; }

// progress ring for the laptop "encrypting / copying" beat
function drawRing(ctx, cx, cy, r, prog, label, color) {
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clampF(prog)); ctx.stroke();
  ctx.fillStyle = '#9fb0d0'; ctx.font = '400 26px ' + FONT; ctx.textAlign = 'center';
  ctx.fillText(label, cx, cy + r + 42); ctx.textAlign = 'left';
}

function fail(reason) {
  document.documentElement.classList.add('no-film');
  const load = document.getElementById('filmLoading');
  if (load) load.classList.add('gone');
  window.flitScene = { state: { p: 0 }, setProgress() {}, setLang() {}, hasWebGL: false, reason: reason };
  readyResolve(window.flitScene);
}

const canvas = document.getElementById('film-canvas');
if (!canvas) { fail('no-canvas'); }

// WebGL capability probe
let renderer = null;
if (canvas) {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) { fail('no-webgl'); }
}

if (renderer) build();

function build() {
  const stage = document.getElementById('film-stage');
  const state = { p: 0 };

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;

  const scene = new THREE.Scene();
  // light fog matching the CSS stage (#f5f5f7) so device edges fade to the airy backdrop, not navy
  scene.fog = new THREE.Fog(0xdfe8fb, 74, 188);

  const camera = new THREE.PerspectiveCamera(32, 1, 1, 400);
  camera.position.set(0, 4, 46);

  // reflections from a procedural room (instant, always there as the fallback)
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
  } catch (e) { /* reflections optional */ }

  // upgrade to a real studio HDRI for richer metal/glass reflections once it loads (env only, bg stays navy)
  try {
    const hdrPmrem = new THREE.PMREMGenerator(renderer);
    new HDRLoader().load('/assets/hdri/photo_studio_01_1k.hdr', (hdr) => {
      try { scene.environment = hdrPmrem.fromEquirectangular(hdr).texture; } catch (e) {}
      hdr.dispose(); hdrPmrem.dispose();
    }, undefined, () => { /* keep RoomEnvironment */ });
  } catch (e) { /* keep RoomEnvironment */ }

  // lights
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(12, 20, 14); scene.add(key);
  const fill = new THREE.DirectionalLight(0x9ec2ff, 0.55); fill.position.set(-14, 6, 8); scene.add(fill);
  const rim = new THREE.DirectionalLight(0x42c8ff, 1.0); rim.position.set(-6, 8, -16); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xe9edf3, 0x9198a6, 0.8));

  // ---------- postprocessing: selective bloom for a premium glow (falls back to plain render on any failure) ----------
  const isMobileGL = window.innerWidth < 768;
  let composer = null;
  try {
    composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: isMobileGL ? 0 : 4 });
    composer.addPass(new RenderPass(scene, camera));
    // subtle, tasteful glow: only bright screen highlights, cyan accents and the lock bloom
    const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.86, luminanceSmoothing: 0.26, intensity: 0.46, radius: 0.66 });
    composer.addPass(new EffectPass(camera, bloom));
  } catch (e) { composer = null; }

  // everything that should scale together to fit narrow screens
  const world = new THREE.Group();
  scene.add(world);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ---------- real photos (vendored, same-origin so the WebGL texture is not tainted) ----------
  const texLoader = new THREE.TextureLoader();
  const gridTex = [];
  GRID_IMG = [];
  for (let i = 1; i <= 9; i++) {
    const t = texLoader.load('/assets/grid/p' + i + '.jpg');
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
    gridTex.push(t);
    const im = new Image(); im.src = '/assets/grid/p' + i + '.jpg';
    im.onload = () => { phoneSig = ''; laptopSig = ''; }; // repaint screens once photos arrive
    GRID_IMG.push(im);
  }

  function makeScreenTexture(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    return { c, ctx: c.getContext('2d'), tex };
  }

  // ---------- PHONE ----------
  const phoneRig = new THREE.Group();
  phoneRig.position.set(-11.5, 1, 1.5);
  phoneRig.rotation.y = 0.4;
  world.add(phoneRig);

  const phoneBody = new THREE.Mesh(
    new RoundedBoxGeometry(7.4, 15.2, 0.9, 6, 1.05),
    new THREE.MeshPhysicalMaterial({ color: 0x0c1220, metalness: 0.9, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.3, envMapIntensity: 0.5 })
  );
  phoneRig.add(phoneBody);

  const phoneScreen = makeScreenTexture(560, 1180);
  const phoneScreenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(6.5, 13.9),
    new THREE.MeshBasicMaterial({ map: phoneScreen.tex, toneMapped: false })
  );
  phoneScreenMesh.position.z = 0.47;
  phoneRig.add(phoneScreenMesh);

  // ---------- LAPTOP ----------
  const laptopRig = new THREE.Group();
  laptopRig.position.set(12.5, -2.6, 0);
  laptopRig.rotation.y = 0.42;
  world.add(laptopRig);

  const alu = new THREE.MeshPhysicalMaterial({ color: 0xa9aeb6, metalness: 0.82, roughness: 0.5, envMapIntensity: 0.26 });
  const base = new THREE.Mesh(new RoundedBoxGeometry(22, 0.9, 15, 4, 0.45), alu);
  laptopRig.add(base);

  // hinge group so the lid opens from the back edge
  const lidGroup = new THREE.Group();
  lidGroup.position.set(0, 0.45, -7.4);
  lidGroup.rotation.x = -0.32;
  laptopRig.add(lidGroup);

  const lidBack = new THREE.Mesh(new RoundedBoxGeometry(22, 14.2, 0.7, 4, 0.4), alu);
  lidBack.position.set(0, 7.1, 0);
  lidGroup.add(lidBack);

  const laptopScreen = makeScreenTexture(1600, 1000);
  const laptopScreenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(20.4, 12.8),
    new THREE.MeshBasicMaterial({ map: laptopScreen.tex, toneMapped: false })
  );
  laptopScreenMesh.position.set(0, 7.1, 0.37);
  lidGroup.add(laptopScreenMesh);

  // key deck hint
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(19, 12), new THREE.MeshStandardMaterial({ color: 0x0d1220, metalness: 0.4, roughness: 0.7 }));
  deck.rotation.x = -Math.PI / 2; deck.position.set(0, 0.47, 1.4); laptopRig.add(deck);

  // ---------- FLOOR ----------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: 0xdce3f0, metalness: 0.28, roughness: 0.42 })
  );
  floor.rotation.x = -Math.PI / 2; floor.position.y = -8; world.add(floor);

  // ---------- PACKET (photo, beat A) ----------
  function makeCardFace(kind) {
    const s = makeScreenTexture(460, 320);
    drawCardFace(s, kind);
    return s;
  }
  const photoFace = makeCardFace('photo');
  const packet = new THREE.Group();
  const photoCard = new THREE.Mesh(
    new RoundedBoxGeometry(4.8, 3.35, 0.22, 4, 0.3),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.35, map: gridTex[0], clearcoat: 0.5, envMapIntensity: 0.6 })
  );
  packet.add(photoCard);
  const lockBadge = makeLock();
  lockBadge.position.set(1.9, 1.35, 0.2);
  lockBadge.scale.setScalar(0);
  packet.add(lockBadge);
  packet.visible = false;
  world.add(packet);

  // ---------- CLIP (clipboard, beat C) ----------
  const clipFace = makeCardFace('clip');
  const clip = new THREE.Group();
  const clipCard = new THREE.Mesh(
    new RoundedBoxGeometry(5.2, 2.2, 0.2, 4, 0.28),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.35, map: clipFace.tex, clearcoat: 0.5 })
  );
  clip.add(clipCard);
  const clipLock = makeLock(); clipLock.position.set(2.1, 0.85, 0.2); clipLock.scale.setScalar(0); clip.add(clipLock);
  clip.visible = false;
  world.add(clip);

  // ---------- particles ----------
  const pcount = window.innerWidth < 768 ? 40 : 130;
  const pgeo = new THREE.BufferGeometry();
  const parr = new Float32Array(pcount * 3);
  for (let i = 0; i < pcount; i++) {
    parr[i * 3] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 90 - 45;
    parr[i * 3 + 1] = (Math.sin(i * 78.233) * 43758.5453 % 1) * 40 - 10;
    parr[i * 3 + 2] = (Math.sin(i * 37.719) * 43758.5453 % 1) * 40 - 30;
  }
  pgeo.setAttribute('position', new THREE.BufferAttribute(parr, 3));
  const particles = new THREE.Points(pgeo, new THREE.PointsMaterial({ color: 0x42c8ff, size: 0.16, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  world.add(particles);

  // ---------- flight anchors ----------
  const PHONE_ANCHOR = new THREE.Vector3(-10, 3, 3);
  const LAPTOP_ANCHOR = new THREE.Vector3(11.5, 4.4, 2.6);

  // ---------- camera keyframes ----------
  const CAM = [
    { p: 0.00, pos: [0, 3, 40], tgt: [0, 1.5, 1] },
    { p: 0.18, pos: [-5, 3, 33], tgt: [-9, 2.5, 2] },  // phone, photo lifts
    { p: 0.34, pos: [-1, 5, 30], tgt: [0, 4, 1] },     // flight up
    { p: 0.50, pos: [4, 4.5, 30], tgt: [7, 3, 1] },    // approach laptop
    { p: 0.58, pos: [7, 4, 30], tgt: [12, 3, 2] },     // laptop receive
    { p: 0.70, pos: [6.5, 4, 29], tgt: [11.5, 3, 2] }, // laptop copy + encrypt (hold on the laptop)
    { p: 0.80, pos: [3, 4, 33], tgt: [4, 3, 1] },      // pull to centre as the clipboard lifts
    { p: 0.90, pos: [-3, 4, 31], tgt: [-7, 3, 2] },    // follow it toward the phone
    { p: 0.97, pos: [-5, 3.5, 33], tgt: [-9, 2.5, 2] },// phone, paste
    { p: 1.00, pos: [-5, 3, 38], tgt: [-10, 2, 2] },
  ];
  const _v = new THREE.Vector3(), _t = new THREE.Vector3();
  function sampleCam(p) {
    let i = 0; while (i < CAM.length - 2 && p > CAM[i + 1].p) i++;
    const a = CAM[i], b = CAM[i + 1];
    const k = smooth(seg(p, a.p, b.p));
    _v.set(lerp(a.pos[0], b.pos[0], k), lerp(a.pos[1], b.pos[1], k), lerp(a.pos[2], b.pos[2], k));
    _t.set(lerp(a.tgt[0], b.tgt[0], k), lerp(a.tgt[1], b.tgt[1], k), lerp(a.tgt[2], b.tgt[2], k));
  }

  // dirty tracking for canvas repaint
  let phoneSig = '', laptopSig = '';
  const captionWrap = document.getElementById('filmCaptionWrap');

  function render(timeMs) {
    const p = state.p;
    const time = (timeMs || 0) * 0.001;

    // camera: dolly back from the target so the devices always sit fully in frame with margin
    sampleCam(p);
    // frame the devices a touch higher so their base always clears the caption band at the bottom
    _t.y -= 1.3;
    const a = camera.aspect || 1.6;
    const k = a < 1.15 ? 1.0 + (1.15 - a) * 1.4 : 1.26;
    const yLift = a < 1.15 ? 1.0 : 0.0;
    _v.set(_t.x + (_v.x - _t.x) * k, _t.y + (_v.y - _t.y) * k + yLift, _t.z + (_v.z - _t.z) * k);
    camera.position.copy(_v);
    camera.lookAt(_t);

    // subtle idle life near the ends
    const idle = (1 - smooth(seg(p, 0, 0.06))) + smooth(seg(p, 0.97, 1));
    phoneRig.rotation.y = 0.4 + Math.sin(time * 0.6) * 0.04 * idle;
    laptopRig.rotation.y = 0.42 + Math.sin(time * 0.5 + 1) * 0.03 * idle;
    particles.rotation.y = time * 0.02;

    // ---------- Beat A: photo phone -> laptop ----------
    const lift = seg(p, 0.06, 0.18);
    const flyA = smooth(seg(p, 0.20, 0.46));
    const enc = seg(p, 0.14, 0.24);
    const landA = seg(p, 0.46, 0.56);
    packet.visible = p > 0.05 && p < 0.62;
    if (packet.visible) {
      const from = PHONE_ANCHOR, to = LAPTOP_ANCHOR;
      const x = lerp(from.x, to.x, flyA);
      const y = lerp(from.y, to.y, flyA) + Math.sin(Math.PI * flyA) * 7.5 + lift * 1.5;
      const z = lerp(from.z, to.z, flyA) + Math.sin(Math.PI * flyA) * -2.0;
      packet.position.set(x, y, z);
      const grow = 0.7 + 0.5 * smooth(lift) - 0.3 * landA;
      packet.scale.setScalar(clamp(grow, 0.2, 1.3));
      packet.rotation.z = Math.sin(Math.PI * flyA) * 0.4;
      packet.rotation.y = 0.4 - flyA * 0.8;
      lockBadge.scale.setScalar(smooth(enc) * (1 - landA));
    }

    // ---------- Beat C: copy on the laptop (encrypt), then clipboard laptop -> phone ----------
    const flyC = smooth(seg(p, 0.78, 0.94));
    const encC = seg(p, 0.78, 0.86);
    clip.visible = p > 0.78 && p <= 1.0;
    if (clip.visible) {
      const from = LAPTOP_ANCHOR, to = new THREE.Vector3(-10, 3.4, 3);
      const x = lerp(from.x, to.x, flyC);
      const y = lerp(from.y, to.y, flyC) + Math.sin(Math.PI * flyC) * 7.0;
      const z = lerp(from.z, to.z, flyC) + Math.sin(Math.PI * flyC) * -1.6;
      clip.position.set(x, y, z);
      clip.scale.setScalar(clamp(0.75 + 0.4 * Math.sin(Math.PI * flyC), 0.3, 1.15));
      clip.rotation.z = Math.sin(Math.PI * flyC) * -0.35;
      clipLock.scale.setScalar(smooth(encC) * (1 - seg(p, 0.9, 0.94)));
    }

    // caption band dissolves right before the film hands off to the next section
    if (captionWrap) captionWrap.style.opacity = (1 - seg(p, 0.985, 1)).toFixed(3);

    // ---------- screen textures (repaint on change only) ----------
    const lang = window.FDI18N ? window.FDI18N.lang : 'en';
    const recvProg = seg(p, 0.46, 0.56);
    const selP = smooth(seg(p, 0.62, 0.66));
    const keyPress = p >= 0.66 && p < 0.69;
    const procP = seg(p, 0.69, 0.78);
    const copied = p >= 0.78;
    const toast = p >= 0.95;
    const clipMode = p >= 0.62;
    const sigPhone = [p > 0.08 ? 1 : 0, toast ? 1 : 0, lang].join('|');
    if (sigPhone !== phoneSig) { phoneSig = sigPhone; drawPhone(phoneScreen, { lifted: p > 0.08, toast: toast }); phoneScreen.tex.needsUpdate = true; }
    const sigLap = [p >= 0.46 ? 1 : 0, Math.round(recvProg * 8), clipMode ? 1 : 0, Math.round(selP * 6), keyPress ? 1 : 0, Math.round(procP * 8), copied ? 1 : 0, lang].join('|');
    if (sigLap !== laptopSig) { laptopSig = sigLap; drawLaptop(laptopScreen, { received: p >= 0.46, prog: recvProg, clipMode: clipMode, selP: selP, keyPress: keyPress, procP: procP, copied: copied }); laptopScreen.tex.needsUpdate = true; }

    if (composer) { try { composer.render(); } catch (e) { composer = null; renderer.render(scene, camera); } }
    else renderer.render(scene, camera);
  }

  // ---------- resize ----------
  // Canvas is sized to the REAL viewport width (never the stale pinned width, so there is no
  // white bar), and the render buffer is kept in sync with the CSS size (updateStyle = true)
  // so the scene never stretches. The stretch is the classic "phone looks way too long" bug
  // that appears when the mobile svh / the ScrollTrigger pin change the stage height after the
  // first paint. A ResizeObserver re-syncs on every size change (pin, orientation, URL bar).
  function resize() {
    const w = Math.round(document.documentElement.clientWidth || window.innerWidth);
    const h = Math.round(stage.getBoundingClientRect().height || window.innerHeight);
    if (w < 2 || h < 2) return;
    renderer.setSize(w, h, true);
    if (composer) composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // scale the whole scene so both devices fit a narrow / portrait viewport, without going tiny
    const a = camera.aspect;
    const s = Math.min(1, Math.max(a < 1.15 ? 0.7 : 0.62, (a + 0.35) / 1.55));
    world.scale.setScalar(s);
    world.position.y = a < 1.15 ? 3.4 : 0; // lift into the vertical centre on portrait
    render(performance.now ? performance.now() : 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  if (window.ResizeObserver) { try { new ResizeObserver(resize).observe(stage); } catch (e) {} }
  resize();

  // first paints
  drawPhone(phoneScreen, { lifted: false, toast: false }); phoneScreen.tex.needsUpdate = true;
  drawLaptop(laptopScreen, { received: false, prog: 0, clipMode: false }); laptopScreen.tex.needsUpdate = true;
  render(0);

  // ---------- dedicated rAF render loop, paused when the film is offscreen ----------
  // (own rAF, not gsap.ticker, so gsap auto-sleep never freezes the scene)
  let onTicker = false, rafId = 0;
  function frame(t) { if (!onTicker) return; render(t); rafId = requestAnimationFrame(frame); }
  function add() { if (!onTicker) { onTicker = true; rafId = requestAnimationFrame(frame); } }
  function remove() { onTicker = false; if (rafId) cancelAnimationFrame(rafId); }
  new IntersectionObserver((ents) => { ents[0].isIntersecting ? add() : remove(); }, { threshold: 0.01 }).observe(stage);
  add();

  // reveal
  const load = document.getElementById('filmLoading');
  if (load) setTimeout(() => load.classList.add('gone'), 120);

  window.flitScene = {
    state: state,
    hasWebGL: true,
    setProgress(p) { state.p = clamp(p, 0, 1); },
    forceRender(p) { if (p != null) state.p = clamp(p, 0, 1); render(performance.now ? performance.now() : 0); },
    setLang() { phoneSig = ''; laptopSig = ''; drawCardFace(photoFace, 'photo'); photoFace.tex.needsUpdate = true; drawCardFace(clipFace, 'clip'); clipFace.tex.needsUpdate = true; },
  };
  window.addEventListener('langchange', () => window.flitScene.setLang());
  readyResolve(window.flitScene);
}

/* ============================ drawing helpers ============================ */

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPhone(s, o) {
  const { ctx, c } = s; const W = c.width, H = c.height;
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0c1424'); g.addColorStop(1, '#070a12');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // status bar
  ctx.fillStyle = '#e8f0ff'; ctx.font = '600 30px ' + FONT; ctx.textBaseline = 'middle';
  ctx.fillText('9:41', 34, 46);
  ctx.textAlign = 'right'; ctx.fillText('Wi-Fi', W - 34, 46); ctx.textAlign = 'left';

  // Dynamic Island (the "current iPhone" tell)
  ctx.fillStyle = '#000'; rr(ctx, W / 2 - 78, 24, 156, 42, 21); ctx.fill();

  // header
  ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#ffffff'; ctx.font = '700 52px ' + FONT; ctx.fillText('Flitdrop', 40, 162);
  // linked pill (brand blue, flat)
  const pill = 'MacBook ' + T('ui.linked');
  ctx.font = '600 30px ' + FONT; const pw = ctx.measureText(pill).width + 78;
  ctx.fillStyle = 'rgba(30,123,255,0.16)'; rr(ctx, 40, 198, pw, 56, 28); ctx.fill();
  ctx.fillStyle = BLUE; ctx.beginPath(); ctx.arc(72, 226, 9, 0, 7); ctx.fill();
  ctx.textBaseline = 'middle'; ctx.fillStyle = '#dceaff'; ctx.fillText(pill, 96, 227); ctx.textBaseline = 'alphabetic';

  // photo grid 3 x 3 (real images)
  const cols = 3, gap = 22, pad = 40, size = (W - pad * 2 - gap * (cols - 1)) / cols;
  const top = 312;
  for (let i = 0; i < 9; i++) {
    const cx = pad + (i % cols) * (size + gap);
    const cy = top + Math.floor(i / cols) * (size + gap);
    if (i === 0 && o.lifted) {
      ctx.setLineDash([10, 9]); ctx.strokeStyle = 'rgba(120,160,220,0.5)'; ctx.lineWidth = 3;
      rr(ctx, cx, cy, size, size, 20); ctx.stroke(); ctx.setLineDash([]);
      continue;
    }
    if (imgReady(GRID_IMG[i])) {
      drawImgRounded(ctx, GRID_IMG[i], cx, cy, size, size, 20);
    } else {
      const gr = PHOTO_GRADS[i % PHOTO_GRADS.length];
      const lg = ctx.createLinearGradient(cx, cy, cx + size, cy + size); lg.addColorStop(0, gr[0]); lg.addColorStop(1, gr[1]);
      ctx.fillStyle = lg; rr(ctx, cx, cy, size, size, 20); ctx.fill();
    }
    if (i === 0) {
      ctx.strokeStyle = BLUE; ctx.lineWidth = 6; rr(ctx, cx + 3, cy + 3, size - 6, size - 6, 18); ctx.stroke();
      ctx.fillStyle = BLUE; ctx.beginPath(); ctx.arc(cx + size - 28, cy + 28, 20, 0, 7); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(cx + size - 37, cy + 28); ctx.lineTo(cx + size - 30, cy + 35); ctx.lineTo(cx + size - 18, cy + 21); ctx.stroke();
    }
  }

  // send button (flat blue)
  const by = H - 150;
  ctx.fillStyle = BLUE; rr(ctx, 40, by, W - 80, 88, 44); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '650 38px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(T('ui.send'), W / 2, by + 44); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

  // paste toast (beat C end)
  if (o.toast) {
    const ty = H - 300;
    ctx.fillStyle = 'rgba(10,20,40,0.94)'; rr(ctx, 40, ty, W - 80, 120, 22); ctx.fill();
    ctx.fillStyle = BLUE; rr(ctx, 40, ty, 8, 120, 4); ctx.fill();
    ctx.fillStyle = '#eaf3ff'; ctx.font = '600 30px ' + FONT;
    wrapText(ctx, T('ui.textReceived'), 78, ty + 48, W - 150, 40);
  }
}

function drawLaptop(s, o) {
  const { ctx, c } = s; const W = c.width, H = c.height;
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0e1526'); g.addColorStop(1, '#070a12');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // window chrome
  ctx.fillStyle = '#0b1120'; ctx.fillRect(0, 0, W, 74);
  const dots = ['#ff5f57', '#febc2e', '#28c840'];
  for (let i = 0; i < 3; i++) { ctx.fillStyle = dots[i]; ctx.beginPath(); ctx.arc(44 + i * 40, 37, 12, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#8fa0c4'; ctx.font = '600 30px ' + FONT; ctx.textBaseline = 'middle';
  ctx.fillText('Flitdrop  ·  ' + T('ui.incoming'), 170, 38);
  // MacBook notch (the "current MacBook" tell) — black tab centred over the top edge
  ctx.fillStyle = '#000'; rr(ctx, W / 2 - 116, -20, 232, 54, 22); ctx.fill();

  // left rail: connected phone
  ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(0, 74, 360, H - 74);
  ctx.fillStyle = 'rgba(30,123,255,0.10)'; rr(ctx, 34, 130, 292, 96, 18); ctx.fill();
  ctx.fillStyle = '#34e2a8'; ctx.beginPath(); ctx.arc(70, 178, 9, 0, 7); ctx.fill();
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#dbe6ff'; ctx.font = '600 30px ' + FONT; ctx.fillText('iPhone', 96, 170);
  ctx.fillStyle = '#7d879e'; ctx.font = '400 24px ' + FONT; ctx.fillText(T('ui.linked'), 96, 200);

  const listX = 400, listW = W - listX - 60;

  if (!o.clipMode) {
    // receive list
    let y = 150;
    if (o.received) { y = drawRow(ctx, listX, y, listW, 'photo.jpg', o.prog < 1 ? null : true, o.prog, true, GRID_IMG[0]); }
    y = drawRow(ctx, listX, y, listW, T('ui.samplePhoto'), true, 1, false, GRID_IMG[1]);
    y = drawRow(ctx, listX, y, listW, 'notes.pdf', true, 1, false, null);
  } else {
    // 1) Notes doc with a selection that sweeps in
    ctx.fillStyle = '#9fb0d0'; ctx.font = '600 28px ' + FONT; ctx.fillText('Notes', listX, 150);
    ctx.font = '400 30px ' + FONT;
    const line1 = 'flitdrop.com/download';
    const tw = ctx.measureText(line1).width;
    const selW = (tw + 16) * clampF(o.selP || 0);
    if (selW > 1) { ctx.fillStyle = 'rgba(30,123,255,0.32)'; ctx.fillRect(listX - 8, 194, selW, 44); }
    ctx.fillStyle = '#eaf3ff'; ctx.fillText(line1, listX, 218);
    ctx.fillStyle = '#7d879e'; ctx.font = '400 26px ' + FONT; ctx.fillText(T('ui.noteSample'), listX, 280);

    // 2) Ctrl C keycap (flashes brand blue on press)
    const kx = listX, ky = 336;
    ctx.fillStyle = o.keyPress ? BLUE : 'rgba(255,255,255,0.14)';
    rr(ctx, kx, ky, 158, 62, 12); ctx.fill();
    ctx.fillStyle = o.keyPress ? '#fff' : '#dbe6ff'; ctx.font = '600 30px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Ctrl C', kx + 79, ky + 32); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

    // 3) processing ring -> done, so the copy reads before it flies back
    const cx = listX + 100, cy = 520;
    if (o.copied) {
      drawRing(ctx, cx, cy, 46, 1, T('ui.copied'), '#34e2a8');
      ctx.strokeStyle = '#34e2a8'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath();
      ctx.moveTo(cx - 20, cy + 2); ctx.lineTo(cx - 6, cy + 16); ctx.lineTo(cx + 22, cy - 16); ctx.stroke();
    } else if (o.procP > 0) {
      drawRing(ctx, cx, cy, 46, o.procP, o.procP < 0.55 ? T('ui.encrypting') : T('ui.copying'), CYAN);
    }
  }
  ctx.textBaseline = 'alphabetic';
}

function drawRow(ctx, x, y, w, name, done, prog, isNew, img) {
  const h = 108;
  ctx.fillStyle = isNew ? 'rgba(30,123,255,0.10)' : 'rgba(255,255,255,0.045)';
  rr(ctx, x, y, w, h, 18); ctx.fill();
  if (isNew) { ctx.strokeStyle = 'rgba(30,123,255,0.45)'; ctx.lineWidth = 2; rr(ctx, x, y, w, h, 18); ctx.stroke(); }
  // thumb — real photo, or a doc tile
  if (imgReady(img)) {
    drawImgRounded(ctx, img, x + 20, y + 20, 68, 68, 14);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; rr(ctx, x + 20, y + 20, 68, 68, 14); ctx.fill();
    ctx.fillStyle = '#7d879e'; ctx.font = '600 22px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PDF', x + 54, y + 55); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  // name
  ctx.fillStyle = '#e6eeff'; ctx.font = '600 30px ' + FONT; ctx.textBaseline = 'middle';
  ctx.fillText(name, x + 110, y + 42);
  ctx.fillStyle = '#7d879e'; ctx.font = '400 24px ' + FONT; ctx.fillText(T('ui.fileSize'), x + 110, y + 78);
  // status
  const rx = x + w - 40;
  if (done === true) {
    ctx.fillStyle = '#34e2a8'; ctx.beginPath(); ctx.arc(rx - 20, y + h / 2, 22, 0, 7); ctx.fill();
    ctx.strokeStyle = '#04140e'; ctx.lineWidth = 5; ctx.beginPath();
    ctx.moveTo(rx - 30, y + h / 2); ctx.lineTo(rx - 22, y + h / 2 + 8); ctx.lineTo(rx - 8, y + h / 2 - 8); ctx.stroke();
  } else {
    const bw = 150; const bx = rx - bw;
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; rr(ctx, bx, y + h / 2 - 5, bw, 10, 5); ctx.fill();
    ctx.fillStyle = BLUE; rr(ctx, bx, y + h / 2 - 5, Math.max(6, bw * clampF(prog)), 10, 5); ctx.fill();
  }
  ctx.textBaseline = 'alphabetic';
  return y + h + 18;
}

function drawCardFace(s, kind) {
  const { ctx, c } = s; const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  if (kind === 'photo') {
    const lg = ctx.createLinearGradient(0, 0, W, H); lg.addColorStop(0, '#ff9a56'); lg.addColorStop(1, '#ff5e8a');
    ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
    // little landscape so it reads as a photo
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(W * 0.74, H * 0.3, 34, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath();
    ctx.moveTo(0, H); ctx.lineTo(W * 0.32, H * 0.55); ctx.lineTo(W * 0.55, H * 0.78); ctx.lineTo(W * 0.78, H * 0.5); ctx.lineTo(W, H * 0.72); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  } else {
    ctx.fillStyle = '#0e1730'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#42c8ff'; ctx.font = '700 60px ' + FONT; ctx.fillText('Aa', 34, 96);
    ctx.fillStyle = 'rgba(220,230,255,0.7)';
    ctx.fillRect(34, 150, W - 200, 22); ctx.fillRect(34, 196, W - 90, 22); ctx.fillRect(34, 242, W - 260, 22);
  }
}

// small 3D padlock: a rounded box body + a torus shackle, emissive cyan
function makeLock() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x0a2740, emissive: 0x2aa8ff, emissiveIntensity: 1.4, metalness: 0.4, roughness: 0.4 });
  const body = new THREE.Mesh(new RoundedBoxGeometry(1.1, 0.9, 0.4, 3, 0.14), mat);
  g.add(body);
  const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.1, 10, 20, Math.PI), mat);
  shackle.position.y = 0.5; g.add(shackle);
  return g;
}

function wrapText(ctx, text, x, y, maxW, lh) {
  const words = text.split(' '); let line = '', yy = y;
  for (let n = 0; n < words.length; n++) {
    const test = line + words[n] + ' ';
    if (ctx.measureText(test).width > maxW && n > 0) { ctx.fillText(line, x, yy); line = words[n] + ' '; yy += lh; }
    else line = test;
  }
  ctx.fillText(line, x, yy);
}
