import type { LogicalAction } from "../domain/types";

export type InputAction = LogicalAction;

export type InputSource = "keyboard" | "gesture" | "button";

export interface RecognizedInput {
  readonly action: InputAction;
  readonly source: InputSource;
}

export type InputSink = (input: RecognizedInput) => void;

export const ALL_INPUT_ACTIONS = [
  "move-left",
  "move-right",
  "soft-drop",
  "hard-drop",
  "rotate-cw",
  "rotate-ccw",
  "hold",
] as const satisfies readonly InputAction[];
