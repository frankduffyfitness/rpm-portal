// Shared 3D scene helpers: vectors and an orbit camera that projects into an SVG viewBox.
// World, same as swingModel.js: x toward the catcher, y up, +z = third-base side.
// Written for the Pitch Lab (2026-11-13). SwingLab.jsx still carries its own copy of
// the camera; it can adopt this module whenever that file is next open.
export const rad = (a) => (a * Math.PI) / 180;
export const deg = (a) => (a * 180) / Math.PI;
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vnorm = (a) => vmul(a, 1 / vlen(a));
export const vlerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
export const UP = [0, 1, 0];
export const pts = (list) => list.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");

// A camera position expressed as an orbit around its target, so a view defined by
// "stand here, look there" can still be dragged.
export function orbitFrom(pos, target) {
  const d = vsub(pos, target), dist = vlen(d);
  return { az: deg(Math.atan2(d[0], d[2])), el: deg(Math.asin(d[1] / dist)), dist };
}

const NEAR = 1; // ft; nothing closer than this to the camera is drawn

export function makeCamera({ az, el, dist, target, f }, scene) {
  const pos = vadd(target, vmul([Math.cos(rad(el)) * Math.sin(rad(az)), Math.sin(rad(el)), Math.cos(rad(el)) * Math.cos(rad(az))], dist));
  const fw = vnorm(vsub(target, pos)), rt = vnorm(vcross(fw, UP)), up = vcross(rt, fw);
  const cam = (p) => { const d = vsub(p, pos); return [vdot(d, rt), vdot(d, up), vdot(d, fw)]; };
  const cy = scene.h * (scene.cy ?? 0.5);
  const flat = (c) => [scene.w / 2 + (f * c[0]) / c[2], cy - (f * c[1]) / c[2], c[2]];
  const proj = (p) => { const c = cam(p); return flat([c[0], c[1], Math.max(c[2], NEAR / 2)]); };
  const depth = (p) => cam(p)[2];
  // One line, clipped to what is in front of the camera. Returns [x1, y1, x2, y2] or null.
  const seg = (a, b) => {
    let ca = cam(a), cb = cam(b);
    if (ca[2] < NEAR && cb[2] < NEAR) return null;
    const cut = (p, q) => { const k = (NEAR - p[2]) / (q[2] - p[2]); return p.map((x, i) => x + (q[i] - x) * k); };
    if (ca[2] < NEAR) ca = cut(ca, cb); else if (cb[2] < NEAR) cb = cut(cb, ca);
    return [...flat(ca).slice(0, 2), ...flat(cb).slice(0, 2)];
  };
  // A polyline through 3D points, split wherever it passes behind the camera.
  // Returns an array of SVG "points" strings.
  const path = (list) => {
    const out = []; let cur = [];
    for (let i = 0; i < list.length - 1; i++) {
      const s = seg(list[i], list[i + 1]);
      if (!s) { if (cur.length) { out.push(cur); cur = []; } continue; }
      if (!cur.length) cur.push([s[0], s[1]]);
      cur.push([s[2], s[3]]);
      if (depth(list[i + 1]) < NEAR) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out.map(pts);
  };
  return { pos, proj, depth, seg, path, f };
}
