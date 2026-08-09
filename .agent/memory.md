# Memory model

Hermes follows its default automatic model: policy-only prompt guidance, background review, consolidation, correction capture, and session indexing. It is available only to the visible orchestrator. Worker bundles explicitly prohibit memory access, which avoids unrelated recall and duplicate search tokens. Repository and tool evidence override memory.

Treat the Hermes SQLite database and Markdown stores as sensitive local data. Keep them outside Git with owner-only permissions. Run `task agent:hermes:health` for the local check; use Hermes's own documented recovery and re-index commands if it reports corruption or missing indexes.
