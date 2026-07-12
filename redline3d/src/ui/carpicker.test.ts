// @vitest-environment jsdom
import { describe, expect, it, test, vi } from "vitest";
import { createCarPicker, setHudMenuMode, type CarOption } from "./carpicker";
import { createTradeHistory } from "./trade-history";

function fakeEl(display = "") {
  return { style: { display } } as HTMLElement;
}

function fakeParent(children: HTMLElement[]) {
  return { children } as unknown as HTMLElement;
}

describe("createCarPicker initial selection", () => {
  const cars = (over: Partial<CarOption>[] = []): CarOption[] => {
    const base: CarOption[] = [
      { name: "DeLorean", url: "/models/delorean.glb", ability: "flux", power: { name: "Flux Brake", desc: "freeze", icon: "clock" } },
      { name: "Solana Paper", url: "/models/trabant.glb" },
    ];
    over.forEach((o, i) => Object.assign(base[i], o));
    return base;
  };

  test("creation fires onPick for the boot card — the default car's ability must actually apply", () => {
    const picks: string[] = [];
    createCarPicker(document.createElement("div"), cars(), (c) => picks.push(c.name));
    expect(picks).toEqual(["DeLorean"]); // paint-only selection = boot car drives with a dead ability
  });

  test("initial pick skips locked cards", () => {
    const picks: string[] = [];
    createCarPicker(document.createElement("div"), cars([{ locked: true }]), (c) => picks.push(c.name));
    expect(picks).toEqual(["Solana Paper"]);
  });

  test("shows Trabant while preserving Solana Paper as the selected inventory ID", () => {
    const parent = document.createElement("div");
    const picks: string[] = [];
    createCarPicker(parent, [
      { name: "Solana Paper", displayName: "Trabant", url: "/models/trabant.glb" },
    ], (car) => picks.push(car.name));

    expect(parent.querySelector(".gtitle-name")?.textContent).toBe("Trabant");
    expect(picks).toEqual(["Solana Paper"]);
  });
});

describe("coming-soon construction tape", () => {
  const roster = (): CarOption[] => [
    { name: "DeLorean", url: "/models/delorean.glb" },
    { name: "Skull", url: "/models/skull.glb", comingSoon: true },
    { name: "Helmet", url: "/models/helmet.glb", comingSoon: true },
    { name: "Vaporwave", url: "/models/vaporwave.glb", comingSoon: true },
  ];

  test("a comingSoon card renders the tape with COMING SOON over the art", () => {
    const parent = document.createElement("div");
    createCarPicker(parent, roster(), () => {});
    const tapes = parent.querySelectorAll(".gcard-tape");
    expect(tapes.length).toBe(3);
    expect(tapes[0].textContent).toContain("COMING SOON");
  });

  test("three taped cards get the three different tape angles", () => {
    const parent = document.createElement("div");
    createCarPicker(parent, roster(), () => {});
    const variants = [...parent.querySelectorAll(".gcard-tape")].map((t) =>
      [...t.classList].find((c) => c.startsWith("tape-")));
    expect(new Set(variants).size).toBe(3); // 3 variants, 3 angles
  });

  test("clicking a taped card does NOT pick it", () => {
    const picks: string[] = [];
    const parent = document.createElement("div");
    createCarPicker(parent, roster(), (c) => picks.push(c.name));
    const cards = parent.querySelectorAll(".gcard");
    (cards[1] as HTMLElement).click(); // Skull — taped
    expect(picks).toEqual(["DeLorean"]); // only the boot pick fired
  });

  test("the boot pick skips comingSoon cards", () => {
    const picks: string[] = [];
    const cars = roster();
    [cars[0], cars[1]] = [cars[1], cars[0]]; // taped Skull first in the roster
    createCarPicker(document.createElement("div"), cars, (c) => picks.push(c.name));
    expect(picks).toEqual(["DeLorean"]);
  });
});

describe("world (level skin) picker locking", () => {
  const worldsWith = (sets: string[]) => ({
    list: () => [
      { key: "synthwave", name: "Synthwave", colors: ["#ff39c0", "#27e7ff", "#ff39c0"], locked: false },
      { key: "neon-city", name: "Neon City", colors: ["#27e7ff", "#0a0f1e", "#27e7ff"], locked: false },
      { key: "volcano", name: "Volcano", colors: ["#ff4d6d", "#120a0a", "#ff4d6d"], locked: true },
    ],
    current: () => "synthwave",
    set: (k: string) => { sets.push(k); },
  });

  const openWorlds = (worlds: ReturnType<typeof worldsWith>) => {
    const parent = document.createElement("div");
    createCarPicker(parent, [{ name: "Solana Paper", url: "/models/trabant.glb" }], () => {},
      undefined, [], undefined, undefined, undefined, worlds);
    (parent.querySelector('[data-go="worlds"]') as HTMLElement).click(); // open the World sub-view
    return parent;
  };

  test("an unowned world is shown SEALED, not hidden", () => {
    const parent = openWorlds(worldsWith([]));
    expect(parent.querySelectorAll("[data-world]").length).toBe(3); // all three, not filtered to owned
    const volcano = parent.querySelector('[data-world="volcano"]') as HTMLElement;
    expect(volcano.classList.contains("locked")).toBe(true);
  });

  test("clicking a locked world does NOT switch the skin", () => {
    const sets: string[] = [];
    const parent = openWorlds(worldsWith(sets));
    (parent.querySelector('[data-world="volcano"]') as HTMLElement).click();
    expect(sets).toEqual([]); // sealed — no switch, like a locked card
  });

  test("an owned world is still selectable", () => {
    const sets: string[] = [];
    const parent = openWorlds(worldsWith(sets));
    (parent.querySelector('[data-world="neon-city"]') as HTMLElement).click();
    expect(sets).toEqual(["neon-city"]);
  });
});

describe("garage carries rarity, not crate odds", () => {
  test("the rarity legend keeps tier names but shows NO percentages or odds", () => {
    const parent = document.createElement("div");
    createCarPicker(parent, [{ name: "Solana Paper", url: "/models/trabant.glb" }], () => {});
    const legend = parent.querySelector(".godds") as HTMLElement;
    expect(legend).not.toBeNull();
    // rarity names stay (collection info) …
    expect(legend.textContent).toContain("Common");
    expect(legend.textContent).toContain("Legendary");
    // … but odds/percentages do NOT — those live only at the crate shop
    expect(legend.textContent).not.toMatch(/%/);
    expect(legend.textContent?.toLowerCase()).not.toContain("odds");
    expect(parent.textContent?.toLowerCase()).not.toContain("crate odds");
  });
});

describe("setHudMenuMode", () => {
  test("hides every hud child except the menu root while menu is open", () => {
    const bal = fakeEl();
    const menu = fakeEl();
    const dock = fakeEl();
    const parent = fakeParent([bal, menu, dock]);

    setHudMenuMode(parent, menu, true);

    expect(bal.style.display).toBe("none");
    expect(menu.style.display).toBe("");
    expect(dock.style.display).toBe("none");
  });

  test("restores hud children when the menu closes", () => {
    const bal = fakeEl("flex");
    const menu = fakeEl();
    const dock = fakeEl("grid");
    const parent = fakeParent([bal, menu, dock]);

    setHudMenuMode(parent, menu, true);
    setHudMenuMode(parent, menu, false);

    expect(bal.style.display).toBe("flex");
    expect(menu.style.display).toBe("");
    expect(dock.style.display).toBe("grid");
  });
});

describe("hamburger product menu", () => {
  const oneCar: CarOption[] = [{ name: "Solana Paper", url: "/models/trabant.glb" }];

  it("always exposes History but can omit Garage and Upgrades", () => {
    const parent = document.createElement("div");
    createCarPicker(parent, oneCar, () => {}, undefined, [], undefined, undefined, undefined, undefined, {
      showGarageAndUpgrades: false,
      onHistory: () => {},
    });
    expect(parent.querySelector('[data-act="history"]')).not.toBeNull();
    expect(parent.querySelector('[data-go="garage"]')).toBeNull();
    expect(parent.querySelector('[data-act="upgrades"]')).toBeNull();
  });

  it("always exposes access-code redemption and invokes its action", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const onAccessCode = vi.fn();
    createCarPicker(parent, oneCar, () => {}, undefined, [], undefined, undefined, undefined, undefined, {
      onAccessCode,
    });
    const hamburger = parent.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!;
    hamburger.click();

    const row = parent.querySelector<HTMLButtonElement>('[data-act="access-code"]');
    expect(row?.textContent).toContain("Redeem access code");
    row?.click();
    expect(onAccessCode).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(hamburger);
    parent.remove();
  });

  it("shows and refreshes Driver Name, then invokes its edit action", () => {
    const parent = document.createElement("div");
    let current: string | null = null;
    const edit = vi.fn();
    createCarPicker(parent, oneCar, () => {}, undefined, [], undefined, undefined, undefined, undefined, {
      driverName: { current: () => current, edit },
    });
    const hamburger = parent.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!;

    hamburger.click();
    const row = parent.querySelector<HTMLButtonElement>('[data-act="driver-name"]')!;
    expect(row).not.toBeNull();
    expect(row.querySelector("small")?.textContent).toBe("choose your name");
    row.click();
    expect(edit).toHaveBeenCalledTimes(1);

    current = "road_king";
    hamburger.click();
    expect(parent.querySelector('[data-driver-name]')?.textContent).toBe("road_king");
  });

  it("closes before History, focuses the hamburger, and lets the panel restore there", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const historyPanel = createTradeHistory(parent, {
      signedIn: () => false,
      flush: async () => undefined,
      load: async () => ({ items: [], nextCursor: null }),
    });
    const order: string[] = [];
    let focusAtCallback: Element | null = null;
    let opening: Promise<void> | undefined;
    createCarPicker(parent, oneCar, () => {}, undefined, [], undefined, (reason) => {
      order.push(`close:${reason}`);
    }, undefined, undefined, {
      showGarageAndUpgrades: false,
      onHistory: () => {
        order.push("history");
        focusAtCallback = document.activeElement;
        opening = historyPanel.open();
      },
    });
    const hamburger = parent.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]');
    const history = parent.querySelector<HTMLButtonElement>('[data-act="history"]');

    hamburger?.click();
    history?.focus();
    history?.click();
    await opening;

    expect(order).toEqual(["close:chain", "history"]);
    expect(hamburger?.style.display).toBe("grid");
    expect(focusAtCallback).toBe(hamburger);
    expect(document.activeElement).toBe(parent.querySelector('[data-history="close"]'));

    historyPanel.close();
    expect(document.activeElement).toBe(hamburger);
    parent.remove();
  });
});
