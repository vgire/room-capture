// Room capture in WebXR (Chrome on Android, ARCore). The foot of the walls is traced
// freely with the reticle on the floor ARCore finds (finger on the screen); the walls and
// the room's outline form as one goes (layout.js), hidden corners being where the walls
// meet. The height comes from two sights, the foot of a wall then its top: no ceiling
// needs to be detected. Exported as JSON (schema painter-capture/1, apps/capture/README.md).
import * as THREE from "three";
import { captureRecord, median } from "./geometry.js";
import { heightAbove, solveRoom, area } from "./layout.js";

const $ = (id) => document.getElementById(id);
const ui = {
  start: $("start"), status: $("status"), name: $("name"), overlay: $("overlay"), hint: $("hint"),
  readout: $("readout"), cross: $("cross"), undo: $("undo"), finish: $("finish"), manual: $("manual"),
  manualValue: $("manual-value"), manualOk: $("manual-ok"), skip: $("skip"), export: $("export"), quit: $("quit"),
  result: $("result"), summary: $("summary"), again: $("again"),
};

let renderer, scene, camera, reticle, wallLines, roomLine, footMark;
let session, hitSource, localSpace;
let step = "trace";                 // trace -> foot -> top -> done
let trace = [];                     // THREE.Vector3 on the floor, local space
let strokes = [];                   // start index of each stroke in `trace`
let stands = [];                    // [x, y] on the plan, where the phone was while tracing
let tracing = false;
let floorY = null;
let lastFloorHit = null;
let room = null;                    // last solveRoom result
let solvedAt = 0, solvedCount = 0;
let foot = null;                    // first sight of the height
let sightHeight = null;             // live, from the second sight
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
  reticle = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.06, 32).rotateX(-Math.PI / 2),
                           new THREE.MeshBasicMaterial({ color: 0x31d18b }));
  reticle.visible = false;
  wallLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd60a }));
  roomLine = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x31d18b }));
  footMark = new THREE.Mesh(new THREE.SphereGeometry(0.03), new THREE.MeshBasicMaterial({ color: 0x0a84ff }));
  footMark.visible = false;
  scene.add(reticle, wallLines, roomLine, footMark);
}

async function start() {
  if (!renderer) setup();
  session = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["hit-test"],
    optionalFeatures: ["dom-overlay"],
    domOverlay: { root: ui.overlay },
  });
  await renderer.xr.setSession(session);
  localSpace = renderer.xr.getReferenceSpace();
  const viewer = await session.requestReferenceSpace("viewer");
  hitSource = await session.requestHitTestSource({ space: viewer, entityTypes: ["plane"] });
  session.addEventListener("selectstart", () => { if (step === "trace") { tracing = true; strokes.push(trace.length); } });
  session.addEventListener("selectend", () => { tracing = false; if (strokes.length && strokes.at(-1) === trace.length) strokes.pop(); });
  session.addEventListener("select", onSelect);
  session.addEventListener("end", onEnd);
  trace = []; strokes = []; stands = []; floorY = null; room = null; foot = null; measured = null; sightHeight = null;
  lastRecord = null;
  step = "trace";
  draw();
  ui.overlay.classList.add("on");
  $("home").hidden = true;
  refresh();
  renderer.setAnimationLoop(onFrame);
}

function onFrame(time, frame) {
  if (!frame) return;
  const pose = frame.getViewerPose(localSpace);
  lastFloorHit = null;
  for (const hit of frame.getHitTestResults(hitSource)) {
    const p = hit.getPose(localSpace);
    if (!p) continue;
    const m = new THREE.Matrix4().fromArray(p.transform.matrix);
    if (new THREE.Vector3().setFromMatrixColumn(m, 1).y < 0.9) continue;   // not facing up: not the floor
    const q = new THREE.Vector3().setFromMatrixPosition(m);
    if (floorY !== null && Math.abs(q.y - floorY) > 0.15) continue;        // a table, a bed
    lastFloorHit = floorY === null ? q : new THREE.Vector3(q.x, floorY, q.z);
    break;
  }
  if (step === "trace" && tracing && lastFloorHit && pose) addPoint(lastFloorHit, pose);
  if (step === "top" && pose) {
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const eye = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
    sightHeight = heightAbove(foot, eye, dir);
    ui.readout.textContent = sightHeight && sightHeight > 1.5
      ? `Hauteur visée : ${sightHeight.toFixed(2)} m` : "Montez la visée jusqu'en haut du mur, au ras du plafond.";
  }
  if (step === "trace" && time - solvedAt > 500 && trace.length !== solvedCount) solve(time);
  reticle.visible = (step === "trace" || step === "foot") && !!lastFloorHit;
  if (reticle.visible) reticle.position.copy(lastFloorHit);
  renderer.render(scene, camera);
}

function addPoint(p, pose) {
  const last = trace.at(-1);
  if (last && strokes.at(-1) < trace.length && last.distanceTo(p) < 0.02) return;
  if (floorY === null) floorY = p.y;
  trace.push(new THREE.Vector3(p.x, floorY, p.z));
  if (trace.length % 5 === 0) {
    const e = pose.transform.position;
    stands.push([e.x, -e.z]);
  }
}

function solve(time) {
  solvedAt = time;
  solvedCount = trace.length;
  if (trace.length >= 10) floorY = median(trace.map((c) => c.y));
  const xs = trace.map((c) => c.x), ys = trace.map((c) => -c.z);
  room = stands.length ? solveRoom(xs, ys, stands.map((s) => s[0]), stands.map((s) => s[1])) : null;
  draw();
  refresh();
}

const local = ([x, y]) => new THREE.Vector3(x, floorY + 0.01, -y);

function draw() {
  wallLines.geometry.dispose();
  wallLines.geometry = new THREE.BufferGeometry().setFromPoints(room ? room.walls.flat().map(local) : []);
  roomLine.geometry.dispose();
  roomLine.geometry = new THREE.BufferGeometry().setFromPoints(room && room.polygon.length ? room.polygon.map(local) : []);
}

function onSelect() {
  if (step === "foot" && lastFloorHit) {
    foot = lastFloorHit.clone();
    footMark.position.copy(foot);
    footMark.visible = true;
    step = "top";
    refresh();
  } else if (step === "top" && sightHeight && sightHeight > 1.5 && sightHeight < 5) {
    setHeight(sightHeight, "two-sights");
  }
}

function setHeight(h, method) {
  measured = { height: h, method };
  step = "done";
  footMark.visible = false;
  refresh();
}

function refresh() {
  const tracingStep = step === "trace";
  ui.undo.hidden = !tracingStep;
  ui.finish.hidden = !tracingStep;
  ui.finish.disabled = !(room && room.polygon.length);
  ui.manual.hidden = !(step === "foot" || step === "top");
  ui.skip.hidden = !(step === "foot" || step === "top");
  ui.export.hidden = step !== "done";
  ui.cross.hidden = step !== "top";
  if (tracingStep) {
    ui.hint.textContent = trace.length === 0
      ? "Visez le sol au pied d'un mur, gardez le doigt sur l'écran et suivez le bas des murs. Les coins cachés ne sont pas nécessaires."
      : "Suivez le bas de chaque mur, là où il est visible. Les murs trouvés s'affichent en jaune, la pièce en vert.";
    if (!room) ui.readout.textContent = trace.length ? `${trace.length} points` : "";
    else if (!room.polygon.length) ui.readout.textContent = `${room.walls.length} morceaux de murs. Pièce pas encore fermée : continuez.`;
    else {
      const s = Math.abs(area(room.polygon));
      ui.readout.textContent = `${room.polygon.length} murs · ${s.toFixed(2)} m² · touchez « Terminer » quand tout est vert`;
    }
  } else if (step === "foot") {
    ui.hint.textContent = "Hauteur : visez le pied d'un mur bien dégagé (viseur vert) et touchez l'écran.";
    ui.readout.textContent = "";
  } else if (step === "top") {
    ui.hint.textContent = "Montez la visée (croix) jusqu'en haut du même mur, au ras du plafond, et touchez l'écran.";
  } else if (step === "done") {
    ui.hint.textContent = measured ? `Hauteur : ${measured.height.toFixed(2)} m. Touchez « Exporter ».` : "Touchez « Exporter ».";
    ui.readout.textContent = "";
  }
}

function finishTrace() {
  if (!(room && room.polygon.length)) return;
  tracing = false;
  step = "foot";
  refresh();
}

function exportRoom() {
  const name = ui.name.value.trim() || "piece";
  lastRecord = captureRecord({
    name, polygon: room.polygon, floorY, height: measured?.height ?? null, heightMethod: measured?.method ?? null,
    source: "webxr-arcore", userAgent: navigator.userAgent, createdAt: new Date().toISOString(),
    trace: trace.map((c) => ({ x: c.x, y: c.y, z: c.z })),
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
  $("home").hidden = false;
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
ui.undo.addEventListener("click", () => {
  if (!strokes.length) return;
  trace.length = strokes.pop();
  solvedCount = -1;
  room = null;
  draw();
  refresh();
});
ui.finish.addEventListener("click", finishTrace);
ui.manualOk.addEventListener("click", () => {
  const h = parseFloat(ui.manualValue.value.replace(",", "."));
  if (h > 1.5 && h < 6) setHeight(h, "manual");
});
ui.skip.addEventListener("click", () => { measured = null; step = "done"; footMark.visible = false; refresh(); });
ui.export.addEventListener("click", exportRoom);
ui.quit.addEventListener("click", () => session?.end());
ui.again.addEventListener("click", () => lastRecord && download(lastRecord));
check();
