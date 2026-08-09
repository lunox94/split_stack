# Fixed-layout Pi package

This package reserves stable header, transcript, and footer regions so status and metrics do not scroll the conversation. Its mechanics and tests are ported from the reference project; the compositor lineage includes pi-powerline-footer under the MIT license. Replace visual identity deliberately.

The header renders Split Stack's eight-tile Hollow Cross in strict ASCII `[]` cells, followed by `SPLIT STACK / PI v<runtime version>`. It imports Pi's runtime `VERSION` and centers each ANSI-colored line by visible width, so the displayed version is never hardcoded.

The `split-stack` theme uses the application's dark background, pale text, lime accent, and exact eight piece colors. The compact ASCII powerline keeps model, thinking level, Git state, context percentage, total tokens, cache reads, solo/team worker activity, TypeScript LSP state, and MCP state visible across two rows. The team status key is `pi-agent-team`, matching the installed team package.
