import type { InputAction } from "./actions";

export function transformScrambledAction(
  action: InputAction,
  scrambleActive: boolean,
): InputAction {
  if (!scrambleActive) return action;

  if (action === "move-left") return "move-right";
  if (action === "move-right") return "move-left";
  if (action === "rotate-cw") return "rotate-ccw";
  if (action === "rotate-ccw") return "rotate-cw";
  return action;
}
