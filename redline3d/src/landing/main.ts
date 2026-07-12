  const root = document.documentElement;
  const header = document.querySelector<HTMLElement>("[data-site-header]");
  const menu = document.querySelector<HTMLElement>("[data-menu]");
  const menuToggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]");
  const heroArt = document.querySelector<HTMLImageElement>("[data-hero-art]");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tutorialVideos = document.querySelectorAll<HTMLVideoElement>("[data-tutorial-video]");

  if (reducedMotion) {
    tutorialVideos.forEach((video) => {
      video.autoplay = false;
      video.pause();
    });
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
