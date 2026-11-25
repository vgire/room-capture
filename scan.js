// Room capture in WebXR (Chrome on Android, ARCore): the corners of the floor tapped one
// after the other on the planes ARCore finds, then the ceiling height, exported as JSON
// (schema painter-capture/1, apps/capture/README.md).
import * as THREE from "three";
import { captureRecord, median, sides } from "./geometry.js";

const $ = (id) => document.getElementById(id);
const ui = {
  start: $("start"), status: $("status"), name: $("name"), overlay: $("overlay"), hint: $("hint"),
  readout: $("readout"), undo: $("undo"), close: $("close"), height: $("height"), export: $("export"),
  quit: $("quit"), result: $("result"), summary: $("summary"), again: $("again"),
};

let renderer, scene, camera, reticle, outline, ceilingMark;
let session, hitSource, localSpace;
let step = "corners";               // corners -> height -> done
let corners = [];                   // THREE.Vector3, local space
let lastFloorHit = null;            // THREE.Vector3 under the reticle
let lastCeiling = null;             // {y, method}
let measured = null;                // {height, method}
let lastRecord = null;

async function check() {
  if (!window.isSecureContext) {
    return fail("La page doit être ouverte en https (ou sur localhost) pour accéder à la réalité augmentée.");
  }
  // without an AR runtime (a desktop) the question may never be answered
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 5000));
  if (!navigator.xr || !(await Promise.race([navigator.xr.isSessionSupported("immersive-ar"), timeout]))) {
    return fail("Ce navigateur ne permet pas la réalité augmentée (WebXR). Ouvrez la page dans Chrome sur un téléphone Android compatible ARCore.");
  }
  ui.start.disabled = false;
  ui.start.textContent = "Commencer le relevé";
}

function fail(message) {
  ui.status.textContent = message;
  ui.start.textContent = "Relevé impossible sur ce téléphone";
  ui.start.disabled = true;
}

function setup() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local");
  document.body.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);
  reticle = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
                           new THREE.MeshBasicMaterial({ color: 0x31d18b }));
  reticle.visible = false;
  scene.add(reticle);
  outline = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd60a }));
  scene.add(outline);
  ceilingMark = new THREE.Mesh(new THREE.SphereGeometry(0.04), new THREE.MeshBasicMaterial({ color: 0x0a84ff }));
  ceilingMark.visible = false;
  scene.add(ceilingMark);
}

async function start() {
  if (!renderer) setup();
  session = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["dom-overlay", "depth-sensing"],
    domOverlay: { root: ui.overlay },
    depthSensing: { usagePreference: ["cpu-optimized"], dataFormatPreference: ["luminance-alpha", "float32"] },
  });
  await renderer.xr.setSession(session);
  localSpace = renderer.xr.getReferenceSpace();
  const viewer = await session.requestReferenceSpace("viewer");
  hitSource = await session.requestHitTestSource({ space: viewer, entityTypes: ["plane"] });
  session.addEventListener("select", onTap);
  session.addEventListener("end", onEnd);
  corners = [];
  measured = null;
  step = "corners";
  ui.overlay.classList.add("on");
  document.getElementById("home").hidden = true;
  refresh();
  renderer.setAnimationLoop(onFrame);
}

function onFrame(time, frame) {
  if (!frame) return;
  const hits = frame.getHitTestResults(hitSource);
  lastFloorHit = null;
  lastCeiling = null;
  const floorY = corners.length ? median(corners.map((c) => c.y)) : null;
  for (const hit of hits) {
    const pose = hit.getPose(localSpace);
    if (!pose) continue;
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    const normalY = new THREE.Vector3().setFromMatrixColumn(m, 1).y;   // plane normal: the pose's y axis
    if (!lastFloorHit && normalY > 0.9 && (floorY === null || Math.abs(p.y - floorY) < 0.15)) {
      lastFloorHit = floorY === null ? p : new THREE.Vector3(p.x, floorY, p.z);
    }
    if (!lastCeiling && normalY < -0.9 && floorY !== null && p.y - floorY > 1.6) {
      lastCeiling = { y: p.y, method: "hit-test", point: p };
    }
  }
  // no ceiling plane: the depth ARCore estimates at the centre of the screen
  if (step === "height" && !lastCeiling && floorY !== null) {
    const pose = frame.getViewerPose(localSpace);
    const view = pose?.views[0];
    const depth = view && frame.getDepthInformation ? safe(() => frame.getDepthInformation(view)) : null;
    if (depth) {
      const d = depth.getDepthInMeters(0.5, 0.5);
      if (d > 0.3 && d < 8) {
        const m = new THREE.Matrix4().fromArray(view.transform.matrix);
        const p = new THREE.Vector3(0, 0, -d).applyMatrix4(m);
        const forwardY = new THREE.Vector3().setFromMatrixColumn(m, 2).negate().y;   // the camera looks along -z
        if (forwardY > 0.7 && p.y - floorY > 1.6) lastCeiling = { y: p.y, method: "depth", point: p };
      }
    }
  }
  reticle.visible = step === "corners" && !!lastFloorHit;
  if (reticle.visible) reticle.position.copy(lastFloorHit);
  ceilingMark.visible = step === "height" && !!lastCeiling;
  if (ceilingMark.visible) ceilingMark.position.copy(lastCeiling.point);
  if (step === "height") {
    ui.readout.textContent = lastCeiling
      ? `Hauteur visée : ${(lastCeiling.y - floorY).toFixed(2)} m (${lastCeiling.method === "depth" ? "profondeur" : "plan du plafond"})`
      : "Plafond pas encore trouvé : visez une zone dégagée du plafond.";
  }
  renderer.render(scene, camera);
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}

function onTap() {
  if (step !== "corners" || !lastFloorHit) return;
  corners.push(lastFloorHit.clone());
  if (corners.length > 1) {   // all corners on the floor height, once known well enough
    const y = median(corners.map((c) => c.y));
    corners.forEach((c) => (c.y = y));
  }
  draw();
  refresh();
}

function draw() {
  const pts = corners.map((c) => c.clone().add(new THREE.Vector3(0, 0.01, 0)));
  if (step !== "corners" && pts.length > 2) pts.push(pts[0]);
  outline.geometry.dispose();
  outline.geometry = new THREE.BufferGeometry().setFromPoints(pts);
}

function plan() {
  return corners.map((c) => [c.x, -c.z]);
}

function refresh() {
  const n = corners.length;
  ui.undo.hidden = step !== "corners";
  ui.close.hidden = step !== "corners";
  ui.close.disabled = n < 3;
  ui.height.hidden = step !== "height";
  ui.export.hidden = step === "corners";
  if (step === "corners") {
    ui.hint.textContent = n === 0
      ? "Visez le pied d'un coin de la pièce (le viseur vert se pose sur le sol), puis touchez l'écran."
      : `${n} coin${n > 1 ? "s" : ""}. Passez au coin suivant, en faisant le tour de la pièce.`;
    const s = n > 1 ? sides(plan()).slice(0, n - 1) : [];
    ui.readout.textContent = s.length ? "Murs : " + s.map((v) => v.toFixed(2)).join(" · ") + " m" : "";
  } else if (step === "height") {
    ui.hint.textContent = "Visez le plafond, puis touchez « Mesurer la hauteur ». Ou exportez sans hauteur.";
  } else {
    ui.hint.textContent = `Hauteur : ${measured.height.toFixed(2)} m. Touchez « Exporter ».`;
  }
}

function closeRoom() {
  if (corners.length < 3) return;
  step = "height";
  draw();
  refresh();
}

function measureHeight() {
  if (!lastCeiling) return;
  const floorY = median(corners.map((c) => c.y));
  measured = { height: lastCeiling.y - floorY, method: lastCeiling.method };
  step = "done";
  refresh();
}

function exportRoom() {
  const name = ui.name.value.trim() || "piece";
  lastRecord = captureRecord({
    name, corners: corners.map((c) => ({ x: c.x, y: c.y, z: c.z })), height: measured?.height ?? null,
    heightMethod: measured?.method ?? null, source: "webxr-arcore", userAgent: navigator.userAgent,
    createdAt: new Date().toISOString(),
  });
  download(lastRecord);
  session.end();
}

function download(record) {
  const blob = new Blob([JSON.stringify(record, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${record.room.name}-webxr.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function onEnd() {
  renderer.setAnimationLoop(null);
  hitSource?.cancel();
  ui.overlay.classList.remove("on");
  document.getElementById("home").hidden = false;
  if (lastRecord) {
    const r = lastRecord.room;
    ui.result.hidden = false;
    ui.summary.textContent = `${r.name}\nSurface au sol : ${r.area.toFixed(2)} m²\nPérimètre : ${r.perimeter.toFixed(2)} m\n`
      + `Murs : ${r.walls.map((v) => v.toFixed(2)).join(" · ")} m\n`
      + `Hauteur : ${r.height == null ? "non mesurée" : r.height.toFixed(2) + " m"}`;
  }
}

// taps on the buttons are not taps on the scene
ui.overlay.querySelector("#bar").addEventListener("beforexrselect", (e) => e.preventDefault());
ui.start.addEventListener("click", () => start().catch((e) => (ui.status.textContent = "Erreur : " + e.message)));
ui.undo.addEventListener("click", () => { corners.pop(); draw(); refresh(); });
ui.close.addEventListener("click", closeRoom);
ui.height.addEventListener("click", measureHeight);
ui.export.addEventListener("click", exportRoom);
ui.quit.addEventListener("click", () => session?.end());
ui.again.addEventListener("click", () => lastRecord && download(lastRecord));
check();
