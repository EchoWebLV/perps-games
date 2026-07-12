# Crate Card Row Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the Wooden, Silver, and Gold crate odds, scrap, coin, and cash rows despite different odds counts.

**Architecture:** Keep the current crate card markup and flex-column layout. Add two explicit CSS layout contracts: a shared two-line odds height and an auto top margin on the purchase block. Lock both contracts down through the existing jsdom crate shop test seam.

**Tech Stack:** TypeScript, DOM/CSS, Vitest, jsdom, Vite

## Global Constraints

- Preserve current card dimensions, colors, copy, prices, odds, rewards, hover behavior, and responsive three-card layout.
- Do not change crate economics, payments, randomness, reveal animations, card artwork, or mobile design.

---

### Task 1: Align Crate Shop Rows

**Files:**
- Modify: `redline3d/src/ui/cratebox.test.ts`
- Modify: `redline3d/src/ui/cratebox.ts`

**Interfaces:**
- Consumes: The existing `.cb-col-odds` and `.cb-col-buy` shop-card classes.
- Produces: A stable CSS contract where `.cb-col-odds` reserves `21px` and centers wrapped odds, while `.cb-col-buy` uses `margin-top:auto`.

- [ ] **Step 1: Write the failing layout regression test**

Add this test to the crate shop test group:

```ts
test("keeps purchase controls aligned when crate odds wrap", () => {
  const parent = document.createElement("div");
  createCrateBox(parent, stubDeps());
  const styles = [...document.head.querySelectorAll("style")]
    .map((style) => style.textContent ?? "")
    .find((text) => text.includes(".cb-col-odds")) ?? "";

  expect(styles).toMatch(/\.cb-col-odds\{[^}]*min-height:21px;[^}]*align-content:center/);
  expect(styles).toMatch(/\.cb-col-buy\{[^}]*margin-top:auto/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd redline3d && npx vitest run src/ui/cratebox.test.ts
```

Expected: FAIL because neither `min-height:21px` nor `margin-top:auto` exists yet.

- [ ] **Step 3: Add the minimal CSS layout fix**

Update the two existing rules in `injectStyles()`:

```css
.cb-col-odds{display:flex;flex-wrap:wrap;justify-content:center;align-content:center;gap:3px 8px;min-height:21px}
.cb-col-buy{position:relative;display:flex;flex-direction:column;gap:5px;width:100%;margin-top:auto}
```

- [ ] **Step 4: Run focused verification and verify GREEN**

Run:

```bash
cd redline3d && npx vitest run src/ui/cratebox.test.ts
npm run build
```

Expected: crate box tests PASS and the production build exits with code 0.

- [ ] **Step 5: Verify the real crate shop visually**

Open the local web app, enter the crate shop, and confirm:

- Wooden, Silver, and Gold coin buttons share one horizontal line.
- Wooden, Silver, and Gold cash buttons share one horizontal line.
- Odds and scrap rows remain readable and centered.

- [ ] **Step 6: Commit the implementation**

```bash
git add redline3d/src/ui/cratebox.test.ts redline3d/src/ui/cratebox.ts
git commit -m "fix: align crate shop purchase rows"
```
