import * as THREE from "three";
import { buildTrack } from "../render/buildings/track";
import { buildGarage } from "../render/buildings/garage";
import { buildUpgrades } from "../render/buildings/upgrades";
import { buildCrates } from "../render/buildings/crates";
import type { BuiltBuilding, Track } from "../render/buildings/types";

const WIDTH = 1024;
const HEIGHT = 720;
const requested = new URLSearchParams(location.search).get("building") ?? "track";
const definitions: Record<string, { color: number; time: number; build: (color: number, track: Track) => BuiltBuilding }> = {
  track: { color: 0x2ee6a6, time: 2.7, build: buildTrack },
  garage: { color: 0x27e7ff, time: 1.2, build: buildGarage },
  upgrades: { color: 0xffd166, time: 0.5, build: buildUpgrades },
  crates: { color: 0xff39c0, time: 1.6, build: buildCrates },
};
const definition = definitions[requested];
if (!definition) throw new Error(`Unknown building: ${requested}`);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-28.45, 28.45, 20, -20, 0.1, 200);
camera.position.set(38, 30, 42);
camera.lookAt(0, 10, 0);

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);

const resources: Array<{ dispose(): void }> = [];
const track: Track = (resource) => { resources.push(resource); return resource; };
const building = definition.build(definition.color, track);
const bounds = new THREE.Box3().setFromObject(building.group);
const center = bounds.getCenter(new THREE.Vector3());
building.group.position.set(-center.x, -bounds.min.y, -center.z);
building.group.traverse((object) => {
  if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; }
});
scene.add(building.group);

scene.add(new THREE.HemisphereLight(0x8fb7ff, 0x14061f, 2.1));
const key = new THREE.DirectionalLight(0x4c1d95, 4.2);
key.position.set(-28, 42, 30);
key.castShadow = true;
scene.add(key);
const rim = new THREE.DirectionalLight(0x27e7ff, 3.3);
rim.position.set(34, 24, -26);
scene.add(rim);

const contactShadowCanvas = document.createElement("canvas");
contactShadowCanvas.width = 256;
contactShadowCanvas.height = 256;
const contactShadowContext = contactShadowCanvas.getContext("2d");
if (!contactShadowContext) throw new Error("Could not create contact shadow canvas context.");
const contactShadowGradient = contactShadowContext.createRadialGradient(128, 128, 0, 128, 128, 128);
contactShadowGradient.addColorStop(0, "rgba(0, 0, 0, 0.26)");
contactShadowGradient.addColorStop(0.38, "rgba(0, 0, 0, 0.16)");
contactShadowGradient.addColorStop(0.68, "rgba(0, 0, 0, 0.07)");
contactShadowGradient.addColorStop(1, "rgba(0, 0, 0, 0)");
contactShadowContext.fillStyle = contactShadowGradient;
contactShadowContext.fillRect(0, 0, 256, 256);
const contactShadowTexture = new THREE.CanvasTexture(contactShadowCanvas);
const contactShadowMaterial = new THREE.MeshBasicMaterial({
  map: contactShadowTexture,
  transparent: true,
  depthWrite: false,
});
const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(42, 20), contactShadowMaterial);
contactShadow.rotation.x = -Math.PI / 2;
contactShadow.position.y = 0.03;
contactShadow.renderOrder = -2;
scene.add(contactShadow);

const shadow = new THREE.Mesh(new THREE.PlaneGeometry(42, 32), new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.42 }));
shadow.rotation.x = -Math.PI / 2;
shadow.receiveShadow = true;
scene.add(shadow);

building.animate?.(definition.time);
renderer.render(scene, camera);
document.documentElement.dataset.ready = "true";
