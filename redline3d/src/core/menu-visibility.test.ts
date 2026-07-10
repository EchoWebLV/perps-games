import { describe, expect, it } from "vitest";
import { showLocalEconomyMenu } from "./menu-visibility";

describe("showLocalEconomyMenu", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])("shows on local browser dev host %s", (hostname) => {
    expect(showLocalEconomyMenu({ dev: true, hostname, native: false })).toBe(true);
  });

  it("hides in a Capacitor WebView even when its hostname is localhost", () => {
    expect(showLocalEconomyMenu({ dev: true, hostname: "localhost", native: true })).toBe(false);
  });

  it.each([
    { dev: false, hostname: "localhost", native: false },
    { dev: true, hostname: "app.example.com", native: false },
    { dev: false, hostname: "app.example.com", native: true },
  ])("hides outside local browser development: %o", (input) => {
    expect(showLocalEconomyMenu(input)).toBe(false);
  });
});
