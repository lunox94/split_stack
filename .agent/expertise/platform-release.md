# platform and release

- Own only delegated Vite, TypeScript, Vitest, Playwright, build scripts, `public/manifest.toml`, notices, and Webxdc packaging files.
- Keep application dependency management on npm and agent-runtime dependency management under `.pi` on Bun; do not merge the graphs.
- Preserve Node 22 CI compatibility, TypeScript project references, and exact application dependency locks.
- Keep `webxdc.js` host-supplied: reference it from `index.html`, mock it only in development, and never include it in the release archive.
- Enforce offline relative asset closure, safe ZIP paths, required root files, accepted compression, valid CRCs, icon dimensions, notices, and exclusion of source maps and external runtime URLs.
- Treat diagnostic `VITE_SPLIT_STACK_SNAPSHOT_HZ` builds as transport experiments outside the rules hash; never mix profiles within one match.
- Run `npm run build` and `npm run verify:xdc`, report archive sizes, then include `npm run check` for integrated readiness.
- Keep deployment, release publication, and external repository writes outside scope unless explicitly authorized.
