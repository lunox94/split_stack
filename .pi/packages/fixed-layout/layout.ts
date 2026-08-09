export type ChatDirection = "next" | "previous";
export type ChatRole = "assistant" | "user";

export interface RenderableContainer {
  children?: unknown[];
  render(width: number): string[];
}

export interface FixedContainers {
  above: RenderableContainer;
  below: RenderableContainer;
  editor: RenderableContainer;
  footer: RenderableContainer | null;
  status: RenderableContainer | null;
}

interface ChildContainerMatch {
  container: RenderableContainer;
  index: number;
}

function isRenderable(value: unknown): value is RenderableContainer {
  if (typeof value !== "object" || value === null) return false;

  return typeof Reflect.get(value, "render") === "function";
}

function findContainerWithChild(tui: unknown, child: unknown): ChildContainerMatch | null {
  if (typeof tui !== "object" || tui === null) return null;

  const children = Reflect.get(tui, "children");
  if (!Array.isArray(children)) return null;

  const index = children.findIndex((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const candidateChildren = Reflect.get(candidate, "children");
    return Array.isArray(candidateChildren) && candidateChildren.includes(child);
  });
  if (index === -1 || !isRenderable(children[index])) return null;

  return { container: children[index], index };
}

export function findFixedContainers(tui: unknown, editor: unknown): FixedContainers | null {
  const match = findContainerWithChild(tui, editor);
  if (!match || typeof tui !== "object" || tui === null) return null;

  const children = Reflect.get(tui, "children");
  if (!Array.isArray(children)) return null;

  const above = children[match.index - 1];
  const below = children[match.index + 1];
  if (!isRenderable(above) || !isRenderable(below)) return null;

  const status = children[match.index - 2];
  const footer = children[match.index + 2];

  return {
    above,
    below,
    editor: match.container,
    footer: isRenderable(footer) ? footer : null,
    status: isRenderable(status) ? status : null,
  };
}

function isChatMessageComponentForRole(component: unknown, role: ChatRole): boolean {
  if (typeof component !== "object" || component === null) return false;

  const componentName = Reflect.get(component, "constructor")?.name;
  if (role === "assistant") return componentName === "AssistantMessageComponent";

  return (
    componentName === "UserMessageComponent" || componentName === "SkillInvocationMessageComponent"
  );
}

function renderLineCount(component: unknown, width: number): number {
  if (!isRenderable(component)) return 0;

  const lines = component.render(width);
  return Array.isArray(lines) ? lines.length : 0;
}

function collectMessageStartLines(
  component: unknown,
  width: number,
  role: ChatRole,
  offset: number,
): { lineCount: number; targets: number[] } {
  const lineCount = renderLineCount(component, width);
  if (isChatMessageComponentForRole(component, role)) return { lineCount, targets: [offset] };
  if (typeof component !== "object" || component === null) return { lineCount, targets: [] };

  const children = Reflect.get(component, "children");
  if (!Array.isArray(children) || children.length === 0) return { lineCount, targets: [] };

  const targets: number[] = [];
  let childOffset = offset;
  let childrenLineCount = 0;
  for (const child of children) {
    const result = collectMessageStartLines(child, width, role, childOffset);
    targets.push(...result.targets);
    childOffset += result.lineCount;
    childrenLineCount += result.lineCount;
  }

  return { lineCount: Math.max(lineCount, childrenLineCount), targets };
}

export function collectChatMessageStartLines(tui: unknown, role: ChatRole): number[] {
  if (typeof tui !== "object" || tui === null) return [];

  const children = Reflect.get(tui, "children");
  const terminal = Reflect.get(tui, "terminal");
  if (!Array.isArray(children)) return [];

  const columns =
    typeof terminal === "object" && terminal !== null
      ? Reflect.get(terminal, "columns")
      : undefined;
  const width = typeof columns === "number" ? Math.max(1, columns) : 80;
  const targets: number[] = [];
  let offset = 0;

  for (const child of children) {
    const result = collectMessageStartLines(child, width, role, offset);
    targets.push(...result.targets);
    offset += result.lineCount;
  }

  return [...new Set(targets)].sort((left, right) => left - right);
}
