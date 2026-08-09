import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolvePlanPath(cwd: string, ticketId: string | null): string {
  const folderName = ticketId ?? "untitled-plan";
  return resolve(cwd, "plans", folderName, "PLAN.md");
}

export function resolvePlanDir(cwd: string, ticketId: string | null): string {
  const folderName = ticketId ?? "untitled-plan";
  return resolve(cwd, "plans", folderName);
}

export function resolvePlanWriteTarget(
  cwd: string,
  rawPath: string,
): { absolutePath: string; insidePlansDir: boolean } {
  const absolutePath = resolve(cwd, rawPath.replace(/^@/, ""));
  const relativePath = relative(resolve(cwd, "plans"), absolutePath);
  const insidePlansDir =
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

  return { absolutePath, insidePlansDir };
}

export function relativePlanPath(ticketId: string | null): string {
  const folderName = ticketId ?? "untitled-plan";
  return `plans/${folderName}/PLAN.md`;
}
