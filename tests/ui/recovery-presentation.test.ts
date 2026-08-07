import { describe, expect, it } from "vitest";

import { recoveryPresentationFor } from "../../src/app/recovery-presentation";

describe("recovery presentation policy", () => {
  it("keeps the initial countdown modal, numeric, and audible", () => {
    expect(recoveryPresentationFor({
      phase: "countdown",
      countdownTicks: 121,
      connectionStatus: "connected",
      resuming: false,
    })).toEqual({
      surface: "modal",
      message: "Match starts in 3",
      inputsEnabled: false,
      countdownCueSecond: 3,
    });
  });

  it("presents a recovery countdown as a quiet, compact resynchronization", () => {
    expect(recoveryPresentationFor({
      phase: "countdown",
      countdownTicks: 121,
      connectionStatus: "connected",
      resuming: true,
    })).toEqual({
      surface: "status",
      message: "Resynchronizing…",
      inputsEnabled: false,
      countdownCueSecond: null,
    });
  });

  it("warns about a suspect connection without interrupting play", () => {
    expect(recoveryPresentationFor({
      phase: "playing",
      countdownTicks: 0,
      connectionStatus: "unstable",
      resuming: false,
    })).toEqual({
      surface: "banner",
      message: "Connection unstable…",
      inputsEnabled: true,
      countdownCueSecond: null,
    });
  });

  it("keeps healthy play unobstructed and interactive", () => {
    expect(recoveryPresentationFor({
      phase: "playing",
      countdownTicks: 0,
      connectionStatus: "connected",
      resuming: false,
    })).toEqual({
      surface: "hidden",
      message: null,
      inputsEnabled: true,
      countdownCueSecond: null,
    });
  });

  it("shows a hard network pause compactly while disabling input", () => {
    expect(recoveryPresentationFor({
      phase: "network-pause",
      countdownTicks: 0,
      connectionStatus: "unstable",
      resuming: false,
    })).toEqual({
      surface: "status",
      message: "Connection interrupted — game paused…",
      inputsEnabled: false,
      countdownCueSecond: null,
    });
  });

  it("shows channel recovery as a compact reconnecting status", () => {
    expect(recoveryPresentationFor({
      phase: "network-pause",
      countdownTicks: 0,
      connectionStatus: "reconnecting",
      resuming: false,
    })).toEqual({
      surface: "status",
      message: "Reconnecting…",
      inputsEnabled: false,
      countdownCueSecond: null,
    });
  });

  it("shows the visible controller what happens when reconnecting times out", () => {
    expect(recoveryPresentationFor({
      phase: "network-pause",
      countdownTicks: 0,
      connectionStatus: "reconnecting",
      resuming: false,
      reconnectingDotCount: 2,
      interruptionRemainingSeconds: 19,
    })).toEqual({
      surface: "status",
      message: "Reconnecting..\nMatch ends in 19s if your opponent does not return.",
      inputsEnabled: false,
      countdownCueSecond: null,
    });
  });

  it("keeps reconnecting copy static when reduced motion is enabled", () => {
    expect(recoveryPresentationFor({
      phase: "network-pause",
      countdownTicks: 0,
      connectionStatus: "reconnecting",
      resuming: false,
      reconnectingDotCount: 1,
      interruptionRemainingSeconds: 8,
      reducedMotion: true,
    }).message).toBe(
      "Reconnecting...\nMatch ends in 8s if your opponent does not return.",
    );
  });

  it("keeps the deadline visible throughout the interrupted incident", () => {
    expect(recoveryPresentationFor({
      phase: "network-pause",
      countdownTicks: 0,
      connectionStatus: "unstable",
      resuming: false,
      reconnectingDotCount: 1,
      interruptionRemainingSeconds: 20,
    }).message).toBe(
      "Reconnecting.\nMatch ends in 20s if your opponent does not return.",
    );
  });

  it("shows returned peer traffic as compact resynchronization", () => {
    expect(recoveryPresentationFor({
      phase: "network-pause",
      countdownTicks: 0,
      connectionStatus: "resynchronizing",
      resuming: false,
    })).toEqual({
      surface: "status",
      message: "Resynchronizing…",
      inputsEnabled: false,
      countdownCueSecond: null,
    });
  });

  it("disables play if the channel is reconnecting before the phase catches up", () => {
    expect(recoveryPresentationFor({
      phase: "playing",
      countdownTicks: 0,
      connectionStatus: "reconnecting",
      resuming: false,
    })).toEqual({
      surface: "status",
      message: "Reconnecting…",
      inputsEnabled: false,
      countdownCueSecond: null,
    });
  });

  it.each([
    ["lobby", "readiness", null],
    ["synchronizing", "modal", "Waiting for both players…"],
    [
      "version-mismatch",
      "modal",
      "The players have different game versions. Update Split Stack to continue.",
    ],
    [
      "desynchronized",
      "modal",
      "The match stopped because the game states could not be reconciled.",
    ],
    ["finished", "hidden", null],
  ] as const)("preserves the %s phase presentation", (phase, surface, message) => {
    expect(recoveryPresentationFor({
      phase,
      countdownTicks: 0,
      connectionStatus: "connected",
      resuming: false,
    })).toEqual({
      surface,
      message,
      inputsEnabled: false,
      countdownCueSecond: null,
    });
  });
});
