  const root = document.documentElement;
  const header = document.querySelector<HTMLElement>("[data-site-header]");
  const menu = document.querySelector<HTMLElement>("[data-menu]");
  const menuToggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]");
  const heroArt = document.querySelector<HTMLImageElement>("[data-hero-art]");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const motionBackground = document.querySelector<HTMLElement>("[data-motion-bg]");
  const tutorialVideos = document.querySelectorAll<HTMLVideoElement>("[data-tutorial-video]");
  let motionFrame = 0;
  let motionX = 0;
  let motionY = 0;

  const clampMotion = (value: number) => Math.max(-1, Math.min(1, value));
  const paintMotion = () => {
    root.style.setProperty("--motion-x", `${(motionX * 18).toFixed(2)}px`);
    root.style.setProperty("--motion-y", `${(motionY * 14).toFixed(2)}px`);
    root.style.setProperty("--motion-far-x", `${(motionX * -7).toFixed(2)}px`);
    root.style.setProperty("--motion-far-y", `${(motionY * -5).toFixed(2)}px`);
    root.style.setProperty("--motion-near-x", `${(motionX * 28).toFixed(2)}px`);
    root.style.setProperty("--motion-near-y", `${(motionY * 21).toFixed(2)}px`);
    motionFrame = 0;
  };
  const queueMotion = (x: number, y: number) => {
    motionX = clampMotion(x);
    motionY = clampMotion(y);
    if (!motionFrame) motionFrame = requestAnimationFrame(paintMotion);
  };

  if (reducedMotion) {
    tutorialVideos.forEach((video) => {
      video.autoplay = false;
      video.pause();
    });
  } else {
    tutorialVideos.forEach((video) => {
      void video.play().catch(() => undefined);
    });
  }

  if (!reducedMotion && motionBackground) {
    addEventListener("pointermove", (event) => {
      queueMotion((event.clientX / innerWidth) * 2 - 1, (event.clientY / innerHeight) * 2 - 1);
    }, { passive: true });

    addEventListener("deviceorientation", (event) => {
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
  if (reducedMotion || !("IntersectionObserver" in window)) {
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
