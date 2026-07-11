export type ModelLoadOutcome = "loaded" | "failed";
export type BootRevealOutcome = ModelLoadOutcome | "timed_out";

export function createBootReveal(options: {
  reveal(outcome: BootRevealOutcome): void;
  timeoutMs: number;
}) {
  let settled = false;
  const timer = setTimeout(() => settle("timed_out"), options.timeoutMs);

  function settle(outcome: BootRevealOutcome) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.reveal(outcome);
  }

  return {
    modelSettled: (outcome: ModelLoadOutcome) => settle(outcome),
    dispose: () => {
      settled = true;
      clearTimeout(timer);
    },
  };
}
