// The room's outline from the points traced along the foot of its walls, on the plan
// (metres, x right, y up the plan): the same steps as painter-room's layout.py, for a
// right-angled room.
//
// 1. The walls' direction: the angle that piles the points up best on a 90-degree grid.
// 2. Wall lines: peaks in the positions of the points across each direction, each with
//    the spans it covers (gaps up to a door or window closed), lengthened to the
//    perpendicular line it nearly reaches: the corners hidden behind furniture need not
//    be traced.
// 3. The lines cut the plan into cells; a flood fill from the middle of where the phone
//    stood, never across a line, gives the room, its outline the polygon.

export function dominantAngle(xs, ys, { bin = 0.02, step = Math.PI / 360 } = {}) {
  let best = 0, bestScore = -1;
  for (let a = 0; a < Math.PI / 2; a += step) {
    const s = sharpness(xs, ys, a, bin);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return best;
}

function sharpness(xs, ys, a, bin) {
  // sum of squared counts of the histograms across both directions: high when the
  // points sit on few lines
  const c = Math.cos(a), s = Math.sin(a);
  const hu = new Map(), hv = new Map();
  for (let i = 0; i < xs.length; i++) {
    const u = Math.floor((xs[i] * c + ys[i] * s) / bin), v = Math.floor((-xs[i] * s + ys[i] * c) / bin);
    hu.set(u, (hu.get(u) || 0) + 1);
    hv.set(v, (hv.get(v) || 0) + 1);
  }
  let t = 0;
  for (const n of hu.values()) t += n * n;
  for (const n of hv.values()) t += n * n;
  return t;
}

export function rotate(xs, ys, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { u: xs.map((x, i) => x * c + ys[i] * s), v: xs.map((x, i) => -x * s + ys[i] * c) };
}

function unrotate([u, v], a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [u * c - v * s, u * s + v * c];
}

// spans covered by `values` on a grid of `step`: first the runs with gaps under `join`
// at least `minRun` long (a wall crossing the line leaves a few points, not a run), then
// those runs with gaps up to `gap` (a door, a window) closed; spans shorter than
// `minLength` dropped
export function spans(values, { step = 0.05, join = 0.15, minRun = 0.2, gap = 2.5, minLength = 0.3 } = {}) {
  const runs = (bins, maxGap) => {
    const out = [];
    let start = bins[0][0], end = bins[0][1];
    for (const [a, b] of bins.slice(1)) {
      if (a - end > maxGap) { out.push([start, end]); start = a; }
      end = Math.max(end, b);
    }
    out.push([start, end]);
    return out;
  };
  if (!values.length) return [];
  const cells = [...new Set(values.map((v) => Math.floor(v / step)))].sort((a, b) => a - b).map((k) => [k * step, (k + 1) * step]);
  const solid = runs(cells, join).filter(([a, b]) => b - a >= minRun);
  if (!solid.length) return [];
  return runs(solid, gap).filter(([a, b]) => b - a >= minLength);
}

// wall lines across one direction: `across` the coordinate the line fixes, `along` the
// other one
export function lines(across, along, axis, { bin = 0.01, band = 0.04, minPoints = 15, merge = 0.12 } = {}) {
  const counts = new Map();
  for (const v of across) {
    const k = Math.floor(v / bin);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  // 5 cm window
  const window = new Map();
  for (const k of counts.keys()) {
    let n = 0;
    for (let d = -2; d <= 2; d++) n += counts.get(k + d) || 0;
    window.set(k, n);
  }
  const order = [...window.entries()].sort((a, b) => b[1] - a[1]);
  const found = [];
  for (const [k, n] of order) {
    if (n < minPoints) break;
    const centre = (k + 0.5) * bin;
    if (found.some((f) => Math.abs(f.coord - centre) < merge)) continue;
    const near = [];
    const pos = [];
    across.forEach((v, i) => { if (Math.abs(v - centre) < band) { near.push(along[i]); pos.push(v); } });
    const sp = spans(near);
    if (sp.length) found.push({ axis, coord: median(pos), spans: sp, points: near.length });
  }
  return found;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

// each span end lengthened to a perpendicular line within `reach` beyond it that passes
// near this line (within `reach` of its spans)
export function completeCorners(all, { reach = 1.5 } = {}) {
  for (const l of all) {
    const perp = all.filter((p) => p.axis !== l.axis);
    const near = (p) => p.spans.some(([a, b]) => l.coord > a - reach && l.coord < b + reach);
    l.spans = l.spans.map(([a, b]) => {
      const before = perp.filter((p) => near(p) && p.coord < a + 0.05 && p.coord > a - reach).map((p) => p.coord);
      const after = perp.filter((p) => near(p) && p.coord > b - 0.05 && p.coord < b + reach).map((p) => p.coord);
      return [before.length ? Math.min(a, Math.max(...before)) : a, after.length ? Math.max(b, Math.min(...after)) : b];
    });
  }
  return all;
}

function covers(line, a, b) {
  if (b <= a) return 0;
  let c = 0;
  for (const [x, y] of line.spans) c += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return c / (b - a);
}

// the polygon (counter-clockwise, rotated frame) of the cells reached from `seed`
export function fill(all, seed, bounds, { minCover = 0.5 } = {}) {
  const cut = (axis, lo, hi) => [...new Set([lo, hi, ...all.filter((l) => l.axis === axis && l.coord > lo && l.coord < hi).map((l) => l.coord)])].sort((a, b) => a - b);
  const xs = cut(0, bounds[0][0], bounds[1][0]);
  const ys = cut(1, bounds[0][1], bounds[1][1]);
  const nx = xs.length - 1, ny = ys.length - 1;
  const inside = Array.from({ length: ny }, () => new Array(nx).fill(false));
  const find = (arr, v) => Math.max(0, Math.min(arr.length - 2, arr.findIndex((x) => x > v) - 1));
  const blocked = (axis, coord, a, b) => all.some((l) => l.axis === axis && l.coord === coord && covers(l, a, b) >= minCover);
  const i0 = find(xs, seed[0]), j0 = find(ys, seed[1]);
  inside[j0][i0] = true;
  const stack = [[j0, i0]];
  let leak = false;
  while (stack.length) {
    const [j, i] = stack.pop();
    for (const [dj, di] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const jj = j + dj, ii = i + di;
      if (jj < 0 || jj >= ny || ii < 0 || ii >= nx) { leak = true; continue; }
      if (inside[jj][ii]) continue;
      if (di ? blocked(0, xs[Math.max(i, ii)], ys[j], ys[j + 1]) : blocked(1, ys[Math.max(j, jj)], xs[i], xs[i + 1])) continue;
      inside[jj][ii] = true;
      stack.push([jj, ii]);
    }
  }
  return { polygon: outline(inside, xs, ys), leak };
}

function outline(inside, xs, ys) {
  const ny = inside.length, nx = inside[0].length;
  const at = (j, i) => j >= 0 && j < ny && i >= 0 && i < nx && inside[j][i];
  const edges = new Map();
  const key = (i, j) => `${i},${j}`;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!inside[j][i]) continue;
    if (!at(j - 1, i)) edges.set(key(i, j), [i + 1, j]);
    if (!at(j, i + 1)) edges.set(key(i + 1, j), [i + 1, j + 1]);
    if (!at(j + 1, i)) edges.set(key(i + 1, j + 1), [i, j + 1]);
    if (!at(j, i - 1)) edges.set(key(i, j + 1), [i, j]);
  }
  let best = [], bestArea = 0;
  while (edges.size) {
    const [startKey, first] = edges.entries().next().value;
    edges.delete(startKey);
    const start = startKey.split(",").map(Number);
    const loop = [start];
    let next = first;
    while (key(...next) !== startKey && edges.has(key(...next))) {
      loop.push(next);
      const k = key(...next);
      next = edges.get(k);
      edges.delete(k);
    }
    const pts = loop.map(([i, j]) => [xs[i], ys[j]]);
    const a = area(pts);
    if (a > bestArea) { bestArea = a; best = pts; }
  }
  // drop the vertices in the middle of a straight side
  return best.filter((b, k) => {
    const a = best[(k - 1 + best.length) % best.length], c = best[(k + 1) % best.length];
    return Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-12;
  });
}

export function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

// the whole solve: traced points (plan xy) and where the phone stood (plan xy)
export function solveRoom(xs, ys, standXs, standYs, opts = {}) {
  if (xs.length < 30) return null;
  const angle = dominantAngle(xs, ys);
  const { u, v } = rotate(xs, ys, angle);
  const st = rotate(standXs, standYs, angle);
  const all = completeCorners([...lines(u, v, 0, opts), ...lines(v, u, 1, opts)], opts);
  const pad = 0.5;
  const bounds = [[Math.min(...u, ...st.u) - pad, Math.min(...v, ...st.v) - pad],
                  [Math.max(...u, ...st.u) + pad, Math.max(...v, ...st.v) + pad]];
  const seed = [median(st.u), median(st.v)];
  const { polygon, leak } = fill(all, seed, bounds, opts);
  const toPlan = (p) => unrotate(p, angle);
  return {
    angle,
    leak,
    polygon: leak ? [] : polygon.map(toPlan),
    walls: all.flatMap((l) => l.spans.map(([a, b]) => (l.axis === 0 ? [[l.coord, a], [l.coord, b]] : [[a, l.coord], [b, l.coord]]).map(toPlan))),
  };
}

// height of the top of a wall above its foot: the point of the sight ray (from `eye` along
// `dir`, local space, y up) nearest the vertical line through the foot
export function heightAbove(foot, eye, dir) {
  const h = Math.hypot(dir.x, dir.z);
  if (h < 1e-6) return null;
  // horizontal distance along the ray's direction to the foot's vertical line
  const t = ((foot.x - eye.x) * dir.x + (foot.z - eye.z) * dir.z) / (h * h);
  if (t <= 0) return null;
  return eye.y + t * dir.y - foot.y;
}
