import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toonifyWorld, disposeToonPass, setToonEnabled, OUTLINE_NAME } from "./toon";

// A big, non-flat box earns both a cel material and an inverted-hull outline from toonifyWorld, so a
// single mesh exercises every untracked build the toon pass creates: the on-duty cel material, the
// off-duty original (kept for the classic flip), and the `__outline` hull's own MeshBasic material.
function toonBoxGroup(): { group: THREE.Group; mesh: THREE.Mesh; original: THREE.Material } {
  const original = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), original);
  const group = new THREE.Group();
  group.add(mesh);
  return { group, mesh, original };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("disposeToonPass", () => {
  it("disposes both style variants and the outline hull material", () => {
    const { group, mesh, original } = toonBoxGroup();

    // toon defaults ON → the cel variant is the one now on mesh.material, the original is stashed.
    const stats = toonifyWorld(group, { outlineWidth: 0.2, outlineMinSize: 2 });
    expect(stats).toMatchObject({ toonMats: 1, hulls: 1 });

    const cel = mesh.material as THREE.MeshToonMaterial;
    expect(cel.isMeshToonMaterial).toBe(true);
    const hull = mesh.children.find((c) => c.name === OUTLINE_NAME) as THREE.Mesh;
    expect(hull).toBeDefined();
    const hullMat = hull.material as THREE.Material;

    const disposeOriginal = vi.spyOn(original, "dispose");
    const disposeCel = vi.spyOn(cel, "dispose");
    const disposeHull = vi.spyOn(hullMat, "dispose");

    disposeToonPass(group);

    // off-duty original (via reclaimToonVariants) + on-duty cel + hull material each freed exactly
    // once — no disposables loop in the harness, so a second dispose would signal a double-free.
    expect(disposeOriginal).toHaveBeenCalledOnce();
    expect(disposeCel).toHaveBeenCalledOnce();
    expect(disposeHull).toHaveBeenCalledOnce();
  });

  it("drops the subtree from the style registry", () => {
    const { group, mesh } = toonBoxGroup();

    toonifyWorld(group, { outlineWidth: 0.2, outlineMinSize: 2 });
    const cel = mesh.material as THREE.MeshToonMaterial;
    expect(cel.isMeshToonMaterial).toBe(true);

    disposeToonPass(group);

    try {
      setToonEnabled(false);
      // the reclaimed subtree is no longer walked by the style toggle, so the classic flip never
      // restores the original — mesh.material still holds the exact cel object it had at teardown.
      expect(mesh.material).toBe(cel);
    } finally {
      setToonEnabled(true); // restore the suite-wide default
    }
  });
});
