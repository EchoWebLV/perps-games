import * as THREE from "three";

// Shared soft blob contact-shadow. Cel-shaded cars with dark inverted-hull outlines float on the
// game's unlit/self-lit roads (which can't receive a real cast shadow), so each car gets a dark
// radial-gradient sprite laid flat on the ground beneath it — grounding it cheaply. One shared
// texture + unit plane geometry across every shadow; you parent a Mesh to the car and scale it to
// the footprint. Shown in BOTH art styles (real cars cast shadows either way). The blob is a plain
// MeshBasic sibling of the (toonified) model, so it is never cel-shaded or outlined; the toon edge
// pass also excludes car groups, so it never gets an ink line.

let _tex: THREE.CanvasTexture | null = null;
function shadowTex(): THREE.CanvasTexture {
  if (_tex) return _tex;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(0,0,0,0.55)"); grd.addColorStop(0.6, "rgba(0,0,0,0.28)"); grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _tex = new THREE.CanvasTexture(c);
  return _tex;
}

let _geo: THREE.PlaneGeometry | null = null;
function shadowGeo(): THREE.PlaneGeometry { return (_geo ??= new THREE.PlaneGeometry(1, 1)); }

/** A flat blob shadow lying on the ground (rotated into the XZ plane). Parent it to the car anchor;
 *  `width` is the lateral (x) size, `length` the along-travel (z) size, in world units. Unlit, no
 *  depth write, renders before the car so the car composites on top. Named `__blobshadow`. */
export function makeBlobShadow(width = 6, length = 10, opacity = 0.85): THREE.Mesh {
  const m = new THREE.Mesh(
    shadowGeo(),
    new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false, opacity, fog: false }),
  );
  m.rotation.x = -Math.PI / 2;   // flat on the ground (plane's local +Y → world +Z = length)
  m.position.y = 0.05;           // just above the road so it never z-fights the surface
  m.scale.set(width, length, 1);
  m.renderOrder = -1;            // draw before the car body
  m.name = "__blobshadow";
  return m;
}
