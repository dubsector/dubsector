import * as THREE from './vendor/three.module.js';

const DEST = 'https://dubsector.dev';
const RECORD_MODE = new URLSearchParams(location.search).has('record');
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const canvas = document.getElementById('scene');

// Layout constants (world units)
const OUTLET_POS = new THREE.Vector3(0.42, 0.05, 0);
const REST_POS = new THREE.Vector3(-0.55, -0.08, 0.6);
const IDLE_POS = new THREE.Vector3(-0.55, -0.08, 0.6);
const ALIGN_RADIUS = 0.22;
const CAPTURE_RADIUS = 0.42; // wider magnetic pull zone that funnels aim toward center
const CONNECT_Z = 0.23; // plugGroup.z when the body's front face is flush with the outlet face
const INSERT_SPEED = 0.85; // world units / sec
const RETRACT_LERP = 4.5; // per second, exponential
const FOLLOW_LERP = 10; // per second, exponential
const CABLE_ANCHOR = new THREE.Vector3(-1.1, -0.9, 0.85); // fixed off-frame point the cord trails to
const CABLE_ATTACH_LOCAL = new THREE.Vector3(0, -0.08, 0.2); // back face of the plug body, in plugGroup-local space

let renderer, scene, camera;
let plugGroup, prongLeft, prongRight, cableMesh, cableMat;
let sparkSprite, glowPanel, glowLight;
let clock;

let dragging = false;
let connected = false;
let connectStartTime = 0;
let plugPos = REST_POS.clone();
let targetXY = { x: IDLE_POS.x, y: IDLE_POS.y };
let dragPlaneZ = REST_POS.z;
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
const dragPlane = new THREE.Plane();
const planeHit = new THREE.Vector3();

init();

function init() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    renderer = null;
  }
  if (!renderer) return;

  document.body.classList.add('webgl-ready');

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(26, 4 / 3, 0.1, 10);
  camera.position.set(1.84, 1.47, 4.96);
  camera.lookAt(-0.06, -0.01, 0.3);

  buildLights();
  buildOutlet();
  buildPlug();
  buildCableMaterial();
  buildSpark();
  updateCable();

  clock = new THREE.Clock();

  if (RECORD_MODE) {
    const params = new URLSearchParams(location.search);
    const w = parseInt(params.get('w') || '640', 10);
    const h = parseInt(params.get('h') || '480', 10);
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    window.__renderAt = renderAt;
    document.body.classList.add('record-mode');
  } else {
    resize();
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    requestAnimationFrame(loop);
  }
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function buildLights() {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x2b2f36, 1.1);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(1.4, 1.8, 2.2);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x5fd0ff, 0.6);
  rim.position.set(-1.5, 0.6, -1.5);
  scene.add(rim);

  glowLight = new THREE.PointLight(0x5fd0ff, 0, 2.2, 2);
  glowLight.position.copy(OUTLET_POS).add(new THREE.Vector3(0, 0, 0.3));
  scene.add(glowLight);
}

function roundedRectShape(w, h, r) {
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x, y + r);
  shape.lineTo(x, y + h - r);
  shape.quadraticCurveTo(x, y + h, x + r, y + h);
  shape.lineTo(x + w - r, y + h);
  shape.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
  shape.lineTo(x + w, y + r);
  shape.quadraticCurveTo(x + w, y, x + w - r, y);
  shape.lineTo(x + r, y);
  shape.quadraticCurveTo(x, y, x, y + r);
  return shape;
}

function roundedRectPath(cx, cy, w, h, r) {
  const path = new THREE.Path();
  const x = cx - w / 2;
  const y = cy - h / 2;
  path.moveTo(x, y + r);
  path.lineTo(x, y + h - r);
  path.quadraticCurveTo(x, y + h, x + r, y + h);
  path.lineTo(x + w - r, y + h);
  path.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
  path.lineTo(x + w, y + r);
  path.quadraticCurveTo(x + w, y, x + w - r, y);
  path.lineTo(x + r, y);
  path.quadraticCurveTo(x, y, x, y + r);
  return path;
}

function roundedSlab(w, h, depth, r, segments = 6) {
  const shape = roundedRectShape(w, h, r);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.18,
    bevelSize: r * 0.35,
    bevelSegments: 3,
    curveSegments: segments,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

// outlet face plate with real cut-through holes for the two slots + ground pin
function outletFaceGeometry(w, h, depth, r) {
  const shape = roundedRectShape(w, h, r);
  shape.holes.push(roundedRectPath(0.18, 0.16, 0.09, 0.32, 0.02));
  shape.holes.push(roundedRectPath(-0.18, 0.16, 0.09, 0.32, 0.02));
  const groundHole = new THREE.Path();
  groundHole.absarc(0, -0.22, 0.11, 0, Math.PI * 2, true);
  shape.holes.push(groundHole);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.18,
    bevelSize: r * 0.35,
    bevelSegments: 3,
    curveSegments: 8,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

function buildOutlet() {
  const group = new THREE.Group();
  group.position.copy(OUTLET_POS);

  // backing wall plate, set well behind the face so it never blocks the holes
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.75, metalness: 0.05 });
  const plate = new THREE.Mesh(roundedSlab(1.35, 1.9, 0.14, 0.16), plateMat);
  plate.position.z = -0.17;
  group.add(plate);

  // socket cover, pierced with real slot + ground holes
  const faceMat = new THREE.MeshStandardMaterial({ color: 0xf4f0e6, roughness: 0.6, metalness: 0.05 });
  const face = new THREE.Mesh(outletFaceGeometry(1.0, 1.5, 0.1, 0.12), faceMat);
  group.add(face);

  // dark recess revealed through the holes; doubles as the connect-glow surface
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.1 });
  glowPanel = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.72, 0.03), slotMat);
  glowPanel.position.set(0, -0.02, -0.075);
  group.add(glowPanel);

  scene.add(group);
}

function buildPlug() {
  plugGroup = new THREE.Group();
  plugGroup.position.copy(plugPos);

  // body: width(X)=0.66, height(Y)=0.78, depth(Z)=0.36, centered on the group origin.
  // local +Z faces the camera (cord side), local -Z faces the wall (prong side).
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.45, metalness: 0.15 });
  const body = new THREE.Mesh(roundedSlab(0.66, 0.78, 0.36, 0.14), bodyMat);
  plugGroup.add(body);

  const prongMat = new THREE.MeshStandardMaterial({ color: 0xcda550, roughness: 0.3, metalness: 0.85 });

  // prongs protrude from the body's -Z (wall-facing) side, matching the outlet slots
  prongLeft = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 0.28), prongMat);
  prongLeft.position.set(0.18, 0.16, -0.3);
  plugGroup.add(prongLeft);

  prongRight = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 0.28), prongMat.clone());
  prongRight.position.set(-0.18, 0.16, -0.3);
  plugGroup.add(prongRight);

  const groundProng = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.24, 20), prongMat.clone());
  groundProng.rotation.x = Math.PI / 2;
  groundProng.position.set(0, -0.22, -0.3);
  plugGroup.add(groundProng);

  scene.add(plugGroup);
}

function buildCableMaterial() {
  cableMat = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.8, metalness: 0.05 });
}

// Rebuilds the cord each frame from a fixed off-frame anchor to the plug's
// current back-face position, so it stretches naturally as the plug moves
// and never rigidly clips through the wall on insertion.
function updateCable() {
  const attach = plugGroup.localToWorld(CABLE_ATTACH_LOCAL.clone());
  const mid1 = attach.clone().lerp(CABLE_ANCHOR, 0.35).add(new THREE.Vector3(0, -0.22, 0.05));
  const mid2 = attach.clone().lerp(CABLE_ANCHOR, 0.7).add(new THREE.Vector3(0, -0.08, -0.05));
  const curve = new THREE.CatmullRomCurve3([attach, mid1, mid2, CABLE_ANCHOR]);
  const geo = new THREE.TubeGeometry(curve, 24, 0.045, 8, false);
  if (cableMesh) {
    cableMesh.geometry.dispose();
    cableMesh.geometry = geo;
  } else {
    cableMesh = new THREE.Mesh(geo, cableMat);
    scene.add(cableMesh);
  }
}

function makeSparkTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(190,235,255,0.9)');
  grad.addColorStop(0.6, 'rgba(95,208,255,0.35)');
  grad.addColorStop(1, 'rgba(95,208,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function buildSpark() {
  const tex = makeSparkTexture();
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
  sparkSprite = new THREE.Sprite(mat);
  sparkSprite.scale.set(0.9, 0.9, 1);
  sparkSprite.position.copy(OUTLET_POS).add(new THREE.Vector3(0, 0.02, 0.15));
  scene.add(sparkSprite);
}

function setConnectVisuals(intensity) {
  glowLight.intensity = intensity * 2.4;
  const c = new THREE.Color(0x14161a).lerp(new THREE.Color(0x5fd0ff), intensity * 0.85);
  glowPanel.material.color.copy(c);
  glowPanel.material.emissive = c;
  glowPanel.material.emissiveIntensity = intensity * 1.6;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---- interactive drag path ----

function onPointerDown(e) {
  if (connected) return;
  dragging = true;
  dragPlaneZ = plugPos.z;
  dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, dragPlaneZ));
  canvas.setPointerCapture(e.pointerId);
  updateTargetFromPointer(e);
}

function onPointerMove(e) {
  if (!dragging) return;
  updateTargetFromPointer(e);
}

function onPointerUp() {
  dragging = false;
}

function updateTargetFromPointer(e) {
  const rect = canvas.getBoundingClientRect();
  pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  if (raycaster.ray.intersectPlane(dragPlane, planeHit)) {
    targetXY.x = THREE.MathUtils.clamp(planeHit.x, -1.3, 1.3);
    targetXY.y = THREE.MathUtils.clamp(planeHit.y, -0.9, 0.9);
  }
}

function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (connected) {
    const elapsed = t - connectStartTime;
    const rampIn = THREE.MathUtils.clamp(elapsed / 0.3, 0, 1);
    setConnectVisuals(rampIn);
    sparkSprite.material.opacity = THREE.MathUtils.clamp(1 - Math.abs(elapsed - 0.15) / 0.35, 0, 1) * 0.9;
    sparkSprite.scale.setScalar(0.7 + rampIn * 0.5);
    if (elapsed > 1.1 && !loop._redirecting) {
      loop._redirecting = true;
      window.location.href = DEST;
    }
  } else {
    if (!dragging && !REDUCED_MOTION) {
      targetXY.x = IDLE_POS.x;
      targetXY.y = IDLE_POS.y + Math.sin(t * 1.3) * 0.035;
    } else if (!dragging) {
      targetXY.x = IDLE_POS.x;
      targetXY.y = IDLE_POS.y;
    }

    // magnetic assist: once the raw pointer target is generally near the socket,
    // pull it toward dead-center so small aiming misses (e.g. slightly too high)
    // still land — mirrors how a real faceplate funnels the plug in.
    let effTargetX = targetXY.x;
    let effTargetY = targetXY.y;
    if (dragging) {
      const targetDist = Math.hypot(targetXY.x - OUTLET_POS.x, targetXY.y - OUTLET_POS.y);
      if (targetDist < CAPTURE_RADIUS) {
        const pull = 1 - targetDist / CAPTURE_RADIUS;
        effTargetX = THREE.MathUtils.lerp(targetXY.x, OUTLET_POS.x, pull * 0.8);
        effTargetY = THREE.MathUtils.lerp(targetXY.y, OUTLET_POS.y, pull * 0.8);
      }
    }

    const followK = 1 - Math.exp(-FOLLOW_LERP * dt);
    plugPos.x += (effTargetX - plugPos.x) * followK;
    plugPos.y += (effTargetY - plugPos.y) * followK;

    const planarDist = Math.hypot(plugPos.x - OUTLET_POS.x, plugPos.y - OUTLET_POS.y);
    if (dragging && planarDist < ALIGN_RADIUS) {
      plugPos.z -= INSERT_SPEED * dt;
      if (plugPos.z <= CONNECT_Z) {
        plugPos.z = CONNECT_Z;
        connected = true;
        connectStartTime = t;
      }
    } else {
      const retractK = 1 - Math.exp(-RETRACT_LERP * dt);
      plugPos.z += (REST_POS.z - plugPos.z) * retractK;
    }

    plugGroup.position.copy(plugPos);
  }

  updateCable();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// ---- deterministic record-mode path (drives the same scene for frame capture) ----

const LOOP_DURATION = 3.2;
const PHASE = { idleEnd: 0.4, slideEnd: 1.4, sparkEnd: 1.7, holdEnd: 2.4, retractEnd: 3.0 };

function renderAt(tMs) {
  const t = (tMs / 1000) % LOOP_DURATION;
  let x = IDLE_POS.x;
  let y = IDLE_POS.y;
  let z = REST_POS.z;
  let glow = 0;
  let spark = 0;

  if (t < PHASE.idleEnd) {
    const p = t / PHASE.idleEnd;
    y = IDLE_POS.y + Math.sin(p * Math.PI * 2) * 0.03;
  } else if (t < PHASE.slideEnd) {
    const p = easeInOutCubic((t - PHASE.idleEnd) / (PHASE.slideEnd - PHASE.idleEnd));
    x = THREE.MathUtils.lerp(IDLE_POS.x, OUTLET_POS.x, p);
    y = THREE.MathUtils.lerp(IDLE_POS.y, OUTLET_POS.y, p);
    z = THREE.MathUtils.lerp(REST_POS.z, CONNECT_Z, p);
  } else if (t < PHASE.sparkEnd) {
    const p = (t - PHASE.slideEnd) / (PHASE.sparkEnd - PHASE.slideEnd);
    x = OUTLET_POS.x;
    y = OUTLET_POS.y;
    z = CONNECT_Z;
    glow = THREE.MathUtils.clamp(p / 0.6, 0, 1);
    spark = Math.sin(p * Math.PI);
  } else if (t < PHASE.holdEnd) {
    x = OUTLET_POS.x;
    y = OUTLET_POS.y;
    z = CONNECT_Z;
    glow = 0.9 + Math.sin((t - PHASE.sparkEnd) * 6) * 0.08;
  } else if (t < PHASE.retractEnd) {
    const p = easeInOutCubic((t - PHASE.holdEnd) / (PHASE.retractEnd - PHASE.holdEnd));
    x = THREE.MathUtils.lerp(OUTLET_POS.x, IDLE_POS.x, p);
    y = THREE.MathUtils.lerp(OUTLET_POS.y, IDLE_POS.y, p);
    z = THREE.MathUtils.lerp(CONNECT_Z, REST_POS.z, p);
    glow = 1 - p;
  } else {
    x = IDLE_POS.x;
    y = IDLE_POS.y;
    z = REST_POS.z;
  }

  plugGroup.position.set(x, y, z);
  setConnectVisuals(glow);
  sparkSprite.material.opacity = spark * 0.9;
  sparkSprite.scale.setScalar(0.7 + glow * 0.5);

  updateCable();
  renderer.render(scene, camera);
}
