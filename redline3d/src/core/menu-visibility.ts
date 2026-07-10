export interface MenuRuntime {
  dev: boolean;
  hostname: string;
  native: boolean;
}

export function showLocalEconomyMenu(input: MenuRuntime): boolean {
  const hostname = input.hostname.replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return input.dev && !input.native && loopback;
}
