# Car models

Drop the car model here as **`car.glb`** (i.e. `public/models/car.glb`).

At runtime it's served at the URL `/models/car.glb` and loaded with three's
`GLTFLoader`. Vite copies everything under `public/` to the build root as-is.

**Format / size:** use **GLB** (single self-contained binary), the **1k-texture**
variant (~6 MB) — not the 4k/28 MB GLB, and not the multi-file glTF or FBX. 1k is
plenty at our scale and loads fast on mobile / the Seeker.

**Licensing:** anything shipped in the paid build must be CC0 / commercial-OK or
original. A CC-NonCommercial or trademarked model (e.g. a Back-to-the-Future
DeLorean) is fine for a local look-test but must be swapped before any real-money
launch. See memory: asset-licensing-constraint.
