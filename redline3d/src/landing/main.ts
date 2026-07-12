  import { initialMotionState, motionEnabled, reduceMotionState, technologyMotionEnabled, tutorialPlaybackEnabled } from "./motion-state";

  const MOTION_STORAGE_KEY = "perps-rider:motion-paused";
  const root = document.documentElement;
  const header = document.querySelector<HTMLElement>("[data-site-header]");
  const menu = document.querySelector<HTMLElement>("[data-menu]");
  const menuToggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]");
  const heroArt = document.querySelector<HTMLImageElement>("[data-hero-art]");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const toggle = document.querySelector<HTMLButtonElement>("[data-motion-toggle]");
  const motionBackground = document.querySelector<HTMLElement>("[data-motion-bg]");
  const tutorialVideos = document.querySelectorAll<HTMLVideoElement>("[data-tutorial-video]");
  const storedMotionPaused = () => {
    try { return sessionStorage.getItem(MOTION_STORAGE_KEY) === "true"; } catch { return false; }
  };
  const storeMotionPaused = (paused: boolean) => {
    try { sessionStorage.setItem(MOTION_STORAGE_KEY, String(paused)); } catch { /* storage is optional */ }
  };
  let motionState = reduceMotionState(
    initialMotionState(storedMotionPaused(), reduceMotion.matches),
    { type: "document-visible", visible: !document.hidden },
  );
  let motionFrame = 0;
  let motionX = 0;
  let motionY = 0;

  const clampMotion = (value: number) => Math.max(-1, Math.min(1, value));
  const paintMotion = () => {
    root.style.setProperty("--motion-x", motionX.toFixed(3));
    root.style.setProperty("--motion-y", motionY.toFixed(3));
    motionFrame = 0;
  };
  const queueMotion = (x: number, y: number) => {
    motionX = clampMotion(x);
    motionY = clampMotion(y);
    if (!motionFrame) motionFrame = requestAnimationFrame(paintMotion);
  };

  const renderMotionState = () => {
    const enabled = motionEnabled(motionState);
    root.classList.toggle("motion-paused", !enabled);
    root.classList.toggle("tech-motion-active", technologyMotionEnabled(motionState));
    if (toggle) {
      toggle.textContent = enabled ? "MOTION ON" : "MOTION OFF";
      toggle.setAttribute("aria-pressed", String(enabled));
      toggle.disabled = motionState.systemReduced;
    }
    tutorialVideos.forEach((video) => {
      if (tutorialPlaybackEnabled(motionState)) void video.play().catch(() => undefined);
      else video.pause();
    });
  };

  const dispatchMotion = (event: Parameters<typeof reduceMotionState>[1]) => {
    motionState = reduceMotionState(motionState, event);
    renderMotionState();
  };

  toggle?.addEventListener("click", () => {
    const paused = !motionState.userPaused;
    storeMotionPaused(paused);
    dispatchMotion({ type: "user-paused", paused });
  });
  reduceMotion.addEventListener("change", (event) => dispatchMotion({ type: "system-reduced", reduced: event.matches }));
  document.addEventListener("visibilitychange", () => dispatchMotion({ type: "document-visible", visible: !document.hidden }));

  const supportsIntersectionObserver = typeof IntersectionObserver !== "undefined";
  if (supportsIntersectionObserver) {
    const sectionObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
      const section = (entry.target as HTMLElement).dataset.motionSection;
      if (section === "tutorial") dispatchMotion({ type: "tutorial-visible", visible: entry.isIntersecting });
      if (section === "technology") dispatchMotion({ type: "technology-visible", visible: entry.isIntersecting });
    }), { threshold: 0.12 });
    document.querySelectorAll<HTMLElement>("[data-motion-section]").forEach((section) => sectionObserver.observe(section));
  } else {
    dispatchMotion({ type: "tutorial-visible", visible: true });
    dispatchMotion({ type: "technology-visible", visible: true });
  }
  renderMotionState();

  if (motionBackground) {
    addEventListener("pointermove", (event) => {
      if (!motionEnabled(motionState)) return;
      queueMotion((event.clientX / innerWidth) * 2 - 1, (event.clientY / innerHeight) * 2 - 1);
    }, { passive: true });

    addEventListener("deviceorientation", (event) => {
      if (!motionEnabled(motionState)) return;
      queueMotion((event.gamma ?? 0) / 30, ((event.beta ?? 45) - 45) / 30);
    }, { passive: true });
  }

  root.classList.add("landing-ready");

  menuToggle?.addEventListener("click", () => {
    const open = menuToggle.getAttribute("aria-expanded") !== "true";
    menuToggle.setAttribute("aria-expanded", String(open));
    menu?.classList.toggle("is-open", open);
  });

  menu?.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
    menuToggle?.setAttribute("aria-expanded", "false");
    menu?.classList.remove("is-open");
  }));

  addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    menuToggle?.setAttribute("aria-expanded", "false");
    menu?.classList.remove("is-open");
  });

  addEventListener("scroll", () => header?.classList.toggle("is-scrolled", scrollY > 24), { passive: true });

  heroArt?.addEventListener("error", () => {
    heroArt.hidden = true;
    heroArt.closest(".hero-poster")?.classList.add("art-failed");
  });

  const reveals = document.querySelectorAll<HTMLElement>("[data-reveal]");
  if (!motionEnabled(motionState) || !supportsIntersectionObserver) {
    reveals.forEach((element) => element.classList.add("is-visible"));
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        (entry.target as HTMLElement).classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8%", threshold: 0.12 });
    reveals.forEach((element) => observer.observe(element));
  }
