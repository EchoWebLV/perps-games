// Slopwheels landing runtime. Zero game/three imports (bundle-isolation is test-enforced): the only
// 3D on this page is the model-viewer custom element, loaded as an EXTERNAL <script> in index.html —
// never an npm import (that would drag three.js into the landing chunk). This module wires scroll
// reveals, the in-view video sections (reusing motion-state's videoSections), the nav, the hero
// trading-card hand's Draco config + phone GLB gating, card tilt, and the live "Crack one open" demo.

import {
  initialMotionState,
  motionEnabled,
  reduceMotionState,
  videoPlaybackEnabled,
} from "./motion-state";
import { initDemoCrate } from "./demo-crate";

const root = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const desktop = matchMedia("(min-width: 768px)");

let motionState = reduceMotionState(
  initialMotionState(reduceMotion.matches),
  { type: "document-visible", visible: !document.hidden },
);

// Play/pause every [data-tutorial-video] according to whether its [data-motion-section] is in view
// (videoSections) AND motion is globally enabled (reduced-motion off + tab visible).
const renderMotionState = () => {
  root.classList.toggle("motion-paused", !motionEnabled(motionState));
  document.querySelectorAll<HTMLElement>("[data-motion-section]").forEach((section) => {
    const id = section.dataset.motionSection!;
    section.querySelectorAll<HTMLVideoElement>("[data-tutorial-video]").forEach((video) => {
      if (videoPlaybackEnabled(motionState, id)) void video.play().catch(() => undefined);
      else video.pause();
    });
  });
};

const dispatchMotion = (event: Parameters<typeof reduceMotionState>[1]) => {
  motionState = reduceMotionState(motionState, event);
  renderMotionState();
};

reduceMotion.addEventListener("change", (event) => dispatchMotion({ type: "system-reduced", reduced: event.matches }));
document.addEventListener("visibilitychange", () => dispatchMotion({ type: "document-visible", visible: !document.hidden }));

const supportsIntersectionObserver = typeof IntersectionObserver !== "undefined";
if (supportsIntersectionObserver) {
  const sectionObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
    const id = (entry.target as HTMLElement).dataset.motionSection;
    if (id) dispatchMotion({ type: "video-section", id, visible: entry.isIntersecting });
  }), { threshold: 0.25 });
  document.querySelectorAll<HTMLElement>("[data-motion-section]").forEach((section) => sectionObserver.observe(section));
} else {
  document.querySelectorAll<HTMLElement>("[data-motion-section]").forEach((section) => {
    const id = section.dataset.motionSection;
    if (id) dispatchMotion({ type: "video-section", id, visible: false });
  });
}
renderMotionState();

root.classList.add("landing-ready");

// ---- nav ----
const nav = document.querySelector<HTMLElement>("[data-nav]");
const menu = document.querySelector<HTMLElement>("[data-menu]");
const menuToggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]");

const closeMenu = () => {
  menuToggle?.setAttribute("aria-expanded", "false");
  menu?.classList.remove("is-open");
};

menuToggle?.addEventListener("click", () => {
  const open = menuToggle.getAttribute("aria-expanded") !== "true";
  menuToggle.setAttribute("aria-expanded", String(open));
  menu?.classList.toggle("is-open", open);
});

menu?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));

addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

addEventListener("scroll", () => nav?.classList.toggle("is-scrolled", scrollY > 24), { passive: true });

// ---- scroll reveals ----
const reveals = document.querySelectorAll<HTMLElement>("[data-reveal]");
if (!motionEnabled(motionState) || !supportsIntersectionObserver) {
  reveals.forEach((element) => element.classList.add("in"));
} else {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      (entry.target as HTMLElement).classList.add("in");
      revealObserver.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.12 });
  reveals.forEach((element) => revealObserver.observe(element));
}

// ---- hero 3D trading-card hand ----
// Flanking cards ship a data-mvsrc placeholder; promote it to a real src only on tablet/desktop so
// phones fetch exactly one GLB (the eager center card). Runs on load and on breakpoint changes.
const promoteFlankingModels = () => {
  if (!desktop.matches) return;
  document.querySelectorAll<HTMLElement>("model-viewer[data-mvsrc]").forEach((mv) => {
    const src = mv.getAttribute("data-mvsrc");
    if (src && !mv.getAttribute("src")) mv.setAttribute("src", src);
  });
};
promoteFlankingModels();
desktop.addEventListener("change", promoteFlankingModels);

if (reduceMotion.matches) {
  document.querySelectorAll("model-viewer").forEach((mv) => mv.removeAttribute("auto-rotate"));
}

// Self-hosted Draco decoder: set on the model-viewer constructor once the external script defines it.
// Decode happens post-fetch, so configuring after whenDefined is safe (smoke-tested).
if (typeof customElements !== "undefined" && customElements.whenDefined) {
  customElements.whenDefined("model-viewer").then(() => {
    const ctor = customElements.get("model-viewer") as unknown as { dracoDecoderLocation?: string } | undefined;
    if (ctor) ctor.dracoDecoderLocation = "/vendor/draco/";
  }).catch(() => undefined);
}

// ---- garage-card hover tilt ----
document.querySelectorAll<HTMLElement>("[data-tilt]").forEach((card) => {
  card.addEventListener("pointermove", (event) => {
    if (!motionEnabled(motionState)) return;
    const rect = card.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    card.style.transform = `perspective(700px) rotateY(${px * 10}deg) rotateX(${-py * 10}deg) translateY(-6px)`;
  });
  card.addEventListener("pointerleave", () => { card.style.transform = ""; });
});

// ---- live demo crate ("Crack one open") ----
initDemoCrate();
