// ─── Swing model for the Swing Lab ───────────────────────────────────────────
// Builds a whole swing from three Blast numbers: attack angle, vertical bat angle
// and time to contact. There is no motion capture behind it. What is exact:
//   - at contact the bat sits at the hitter's vertical bat angle,
//   - at contact the sweet spot is moving at his attack angle, straight at the pitcher.
// Everything else is a fixed, generic swing shape so hitters differ only by their
// own numbers: the hands turn on an arc around a chest pivot, the bat lags behind
// the hands and releases into contact, all on one tilted swing plane. Early on the
// bat starts up by the shoulder and drops onto the plane; after contact it wraps up.
//
// World (feet): x toward the catcher (pitcher is -x), y up, z toward third base.
// A righty stands at +z and reaches across the plate toward -z.
export const UP = [0, 1, 0];
export const rad = (a) => (a * Math.PI) / 180;
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vnorm = (a) => vmul(a, 1 / Math.hypot(a[0], a[1], a[2]));
const smooth = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const BAT_LEN = 2.75; // 33 in
export const SWEET = 2.25;   // sweet spot, 6 in from the end
const ARM = 1.5;             // chest pivot to hands
const PSI0 = -140;           // bat angle on the plane at launch (0 = contact)
const ALPHA0 = -80, ALPHA1 = 50; // hands angle around the pivot: launch, contact
const P_BAT = 2.4, P_ARM = 1.2;  // the bat releases late; the hands go first
export const FOLLOW = 0.45;      // follow-through shown, as a share of time to contact
export const TAU_END = 1 + FOLLOW;

// Angles on the swing plane (degrees) at swing time tau, where 1 = contact.
function planeAngles(tau) {
  if (tau <= 1) return { psi: PSI0 * (1 - Math.pow(tau, P_BAT)), alpha: ALPHA0 + (ALPHA1 - ALPHA0) * Math.pow(tau, P_ARM) };
  const u = tau - 1; // keep the speed from contact, then slow down
  return { psi: -PSI0 * P_BAT * (u - (u * u) / 1.1), alpha: ALPHA1 + (ALPHA1 - ALPHA0) * P_ARM * (u - (u * u) / 1.2) };
}
// The hands are still moving at contact, so the sweet spot's direction of travel is
// a few degrees off square to the bat. DELTA is that offset on the plane; the plane
// is then aimed so the travel direction lands exactly on the attack angle.
const DELTA = (() => {
  const p = (tau) => { const { psi, alpha } = planeAngles(tau); return [ARM * Math.cos(rad(alpha)) + SWEET * Math.cos(rad(psi)), ARM * Math.sin(rad(alpha)) + SWEET * Math.sin(rad(psi))]; };
  const a = p(1 - 1e-5), b = p(1);
  return Math.atan2(-(b[0] - a[0]), b[1] - a[1]);
})();

export function swingModel(attackAngle, vertBatAngle, lefty) {
  const side = lefty ? -1 : 1;  // which side of the plate the hitter stands on (z sign)
  const a = rad(attackAngle);
  const v = [-Math.cos(a), Math.sin(a), 0]; // sweet-spot travel at contact
  // w = the direction on the plane square to v; solve it so the bat's tilt is the vertical bat angle.
  const wy = (Math.sin(rad(vertBatAngle)) + Math.sin(DELTA) * Math.sin(a)) / Math.cos(DELTA);
  const wx = wy * Math.tan(a);
  const w = [wx, wy, -side * Math.sqrt(Math.max(0, 1 - wx * wx - wy * wy))];
  const e1 = vsub(vmul(w, Math.cos(DELTA)), vmul(v, Math.sin(DELTA))); // bat direction at contact
  const e2 = vadd(vmul(w, Math.sin(DELTA)), vmul(v, Math.cos(DELTA))); // a quarter turn later on the plane
  // Hands stay about belt-to-chest high, so a steeper bat meets a lower ball.
  const contact = [-1.2, clamp(3.4 + SWEET * Math.sin(rad(vertBatAngle)), 1.6, 3.0), 0];
  const handsAtContact = vsub(contact, vmul(e1, SWEET));
  const onPlane = (ang) => vadd(vmul(e1, Math.cos(rad(ang))), vmul(e2, Math.sin(rad(ang))));
  const pivot = vsub(handsAtContact, vmul(onPlane(ALPHA1), ARM));

  const at = (tau) => {
    const { psi, alpha } = planeAngles(tau);
    const d = onPlane(psi);
    const su = smooth((tau - 1) / FOLLOW);
    const lift = tau <= 1 ? 50 * (1 - smooth(tau / 0.8)) : 40 * su;           // bat tipped up off the plane
    const rise = tau <= 1 ? 1.1 * (1 - smooth(tau / 0.85)) : 0.9 * su;        // hands above the plane
    const upPerp = vnorm(vsub(UP, vmul(d, vdot(UP, d))));
    const dir = vadd(vmul(d, Math.cos(rad(lift))), vmul(upPerp, Math.sin(rad(lift))));
    const hands = vadd(vadd(pivot, vmul(onPlane(alpha), ARM)), [0, rise, 0]);
    return { tau, hands, dir, sweet: vadd(hands, vmul(dir, SWEET)), tip: vadd(hands, vmul(dir, BAT_LEN)) };
  };
  return { at, contact, travel: v, batAtContact: e1, handsAtContact, pivot, normal: vnorm(vcross(e1, e2)) };
}
