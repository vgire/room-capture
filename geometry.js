// Pure helpers of the room capture, shared by the page and its tests (node --test).

// A point of the WebXR "local" space (metres, y up, -z ahead at the start) on the plan seen
// from above, x right and y up the plan: (x, -z). The same convention as RoomTrace once
// read by painter-room, so that the plans compare without a mirror.
export function planXY(p) {
  return [p.x, -p.z];
}

export function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;   // > 0 counter-clockwise
}

export function sides(poly) {
  return poly.map(([x0, y0], i) => {
    const [x1, y1] = poly[(i + 1) % poly.length];
    return Math.hypot(x1 - x0, y1 - y0);
  });
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  return n === 0 ? NaN : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

// The export, schema "painter-capture/1" (apps/capture/README.md). `polygon`: the room's
// outline on the plan (made counter-clockwise here); `trace`: the points traced along the
// foot of the walls in the local space, kept to work on them again later.
export function captureRecord({ name, polygon, floorY, height, heightMethod, source, userAgent, createdAt, trace = [] }) {
  let poly = polygon.map(([x, y]) => [x, y]);
  if (area(poly) < 0) poly = poly.reverse();
  const round = (v) => Math.round(v * 10000) / 10000;
  return {
    schema: "painter-capture/1",
    source,
    createdAt,
    userAgent,
    room: {
      name,
      floorPolygon: poly.map(([x, y]) => [round(x), round(y)]),
      height: height == null ? null : round(height),
      heightMethod: heightMethod ?? null,
      area: round(Math.abs(area(poly))),
      perimeter: round(sides(poly).reduce((a, b) => a + b, 0)),
      walls: sides(poly).map(round),
      doors: [],
      windows: [],
      floorY: round(floorY),
      trace: trace.map((c) => [round(c.x), round(c.y), round(c.z)]),
    },
  };
}
