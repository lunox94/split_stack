import { RULES } from "../config/rules";
import type {
  CompetitiveConnectionStatus,
  CompetitivePhase,
} from "../match/competitive-session";
import { STRINGS, formatString } from "./strings";

export type RecoveryPresentationSurface =
  | "hidden"
  | "modal"
  | "banner"
  | "status"
  | "readiness";

export interface RecoveryPresentationInput {
  phase: CompetitivePhase;
  countdownTicks: number;
  connectionStatus: CompetitiveConnectionStatus;
  resuming: boolean;
}

export interface RecoveryPresentation {
  surface: RecoveryPresentationSurface;
  message: string | null;
  inputsEnabled: boolean;
  countdownCueSecond: number | null;
}

export function recoveryPresentationFor(
  input: RecoveryPresentationInput,
): RecoveryPresentation {
  if (input.phase === "countdown") {
    if (input.resuming) {
      return {
        surface: "status",
        message: STRINGS["match.resynchronizing"],
        inputsEnabled: false,
        countdownCueSecond: null,
      };
    }
    const second = Math.max(
      1,
      Math.ceil(input.countdownTicks / RULES.timing.ticksPerSecond),
    );
    return {
      surface: "modal",
      message: formatString("match.countdown", { seconds: second }),
      inputsEnabled: false,
      countdownCueSecond: second,
    };
  }
  if (input.phase === "playing") {
    if (input.connectionStatus === "unstable") {
      return {
        surface: "banner",
        message: STRINGS["match.connectionUnstable"],
        inputsEnabled: true,
        countdownCueSecond: null,
      };
    }
    if (input.connectionStatus !== "connected") {
      return {
        surface: "status",
        message: STRINGS["match.reconnecting"],
        inputsEnabled: false,
        countdownCueSecond: null,
      };
    }
    return {
      surface: "hidden",
      message: null,
      inputsEnabled: true,
      countdownCueSecond: null,
    };
  }
  if (input.phase === "network-pause") {
    return {
      surface: "status",
      message: input.connectionStatus === "unstable"
        ? STRINGS["match.connectionInterrupted"]
        : input.connectionStatus === "resynchronizing"
          ? STRINGS["match.resynchronizing"]
          : STRINGS["match.reconnecting"],
      inputsEnabled: false,
      countdownCueSecond: null,
    };
  }
  if (input.phase === "lobby") {
    return {
      surface: "readiness",
      message: null,
      inputsEnabled: false,
      countdownCueSecond: null,
    };
  }
  if (input.phase === "synchronizing") {
    return {
      surface: "modal",
      message: STRINGS["match.waitingForReady"],
      inputsEnabled: false,
      countdownCueSecond: null,
    };
  }
  if (input.phase === "version-mismatch") {
    return {
      surface: "modal",
      message: STRINGS["match.versionMismatch"],
      inputsEnabled: false,
      countdownCueSecond: null,
    };
  }
  if (input.phase === "desynchronized") {
    return {
      surface: "modal",
      message: STRINGS["match.desynchronization"],
      inputsEnabled: false,
      countdownCueSecond: null,
    };
  }
  return {
    surface: "hidden",
    message: null,
    inputsEnabled: false,
    countdownCueSecond: null,
  };
}
