# Issue tracker

Selected adapter: **github**.

The canonical remote tracker is GitHub Issues in `lunox94/split_stack`. An issue is required only for work that spans agent sessions, needs tracker-visible dependencies, or is explicitly requested for the backlog. Ordinary single-session work does not need a synthetic issue.

Agents may read and search issues freely. Creating, editing, labeling, assigning, commenting on, or closing an issue is an external write and requires explicit user approval for that action. Agents never close issues autonomously.

Use the repository's existing labels when they describe the work: `bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`, and `wontfix`. Do not invent workflow labels or milestones without approval. Link durable plans as `plans/GH-<number>/PLAN.md`; use `plans/LOCAL-<kebab-slug>/PLAN.md` when an approved plan intentionally has no issue.
