# paseo-plugin-switch-provider

Continue a Paseo agent session on another provider and model. Large sessions get a short history with pointers to a transcript file.

Open an agent, press Ctrl+K (⌘K on macOS), and choose **Switch provider…**. Pick a provider, then a model. Paseo opens the new agent in the same workspace.

## Install

```sh
paseo plugin install github:yuchi0531/paseo-plugin-switch-provider
```

Needs Paseo 0.17 or later and the `paseo` command on the daemon's PATH. Switching to or from OpenCode also needs the `opencode` command.

See [OVERVIEW.md](OVERVIEW.md) for how it works and its limits.

## Fork changes (yuchi0531)

Keeps the upstream feature set and updates it for current Paseo releases:

- **Dependencies moved to Paseo 0.17.5** (`@getpaseo/client`, `@getpaseo/plugin`). Upstream pinned 0.11.2, six minor releases behind; `npm run typecheck` and `npm run check` pass against 0.17.5.
- **Installable again.** Upstream ships `npm-shrinkwrap.json`, which npm 12 rejects for the declared `npm ci` build step (`EUSAGE: only install with an existing package-lock.json`). This fork ships a `package-lock.json` instead, so the manifest's build step works on current npm.
- **Daemon endpoint resolution hardened** in `server/daemon.ts`: honours `PASEO_HOST`, falls back to `paseo daemon status --json`, then to `127.0.0.1:6767`; handles wildcard listen addresses, passes `PASEO_PASSWORD` when the daemon has one, and sets connect timeouts.
- **Switching never fails on a refused import.** Paseo refuses a native import into OpenCode while it shares a discovered `opencode serve` service ("Custom OpenCode MCP servers or process environment require an isolated server"); upstream surfaced that as an error. The fork logs the reason and continues with the transcript handoff instead: a new agent in the same workspace that reads the exported transcript first.
- `requirements.paseo` raised to `>=0.17.0`.

Upstream manifest `build` is unchanged: `npm ci --omit=dev --ignore-scripts`.

## License

MIT
