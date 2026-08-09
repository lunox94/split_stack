import assert from "node:assert/strict";
import test from "node:test";

import { parseFixedLayoutConfig } from "./config.ts";
import { collectChatMessageStartLines, findFixedContainers } from "./layout.ts";

class Lines {
  private readonly lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  render(_width: number): string[] {
    return this.lines;
  }
}

class Container {
  readonly children: Array<Lines | Container | UserMessageComponent | AssistantMessageComponent>;

  constructor(
    children: Array<Lines | Container | UserMessageComponent | AssistantMessageComponent>,
  ) {
    this.children = children;
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
}

class UserMessageComponent extends Lines {}
class AssistantMessageComponent extends Lines {}

test("configuration preserves the existing powerline fixed-editor settings", () => {
  const config = parseFixedLayoutConfig({
    outputPad: 2,
    powerline: {
      copyOnSelect: false,
      fixedEditor: true,
      mouseScroll: false,
      scrollAwayCard: false,
    },
    powerlineShortcuts: {
      jumpChatBottom: "CTRL+G",
    },
  });

  assert.equal(config.enabled, true);
  assert.equal(config.mouseScroll, false);
  assert.equal(config.scrollAwayCard, false);
  assert.equal(config.autoCopyOnSelect, false);
  assert.equal(config.outputPad, 2);
  assert.equal(config.shortcuts.jumpBottom, "ctrl+g");
});

test("fixed containers are discovered around the active editor", () => {
  const editor = new Lines(["editor"]);
  const status = new Container([new Lines(["status"])]);
  const above = new Container([new Lines(["powerline top"])]);
  const editorContainer = new Container([editor]);
  const below = new Container([new Lines(["powerline bottom"])]);
  const footer = new Container([new Lines(["footer"])]);
  const tui = {
    children: [new Container([]), status, above, editorContainer, below, footer],
  };

  assert.deepEqual(findFixedContainers(tui, editor), {
    above,
    below,
    editor: editorContainer,
    footer,
    status,
  });
});

test("chat navigation targets follow rendered user and assistant message offsets", () => {
  const chat = new Container([
    new UserMessageComponent(["user-a", "user-b"]),
    new AssistantMessageComponent(["assistant"]),
  ]);
  const tui = {
    children: [new Lines(["header"]), chat],
    terminal: { columns: 80 },
  };

  assert.deepEqual(collectChatMessageStartLines(tui, "user"), [1]);
  assert.deepEqual(collectChatMessageStartLines(tui, "assistant"), [3]);
});
