# Installation reference

BIOS Implant installs from the public marketplace
[`8hats/marketplace`](https://github.com/8hats/marketplace). No package registry sits
in the path: the marketplace serves this tree directly. Node ≥ 20 must be on
`PATH` — the local companion MCP runs under it.

Handing this to an agent instead of doing it yourself: paste the block in
[`docs/one-prompt-install.md`](../../docs/one-prompt-install.md) and it works out
which harness it is in.

## Claude Code — verified

```text
/plugin marketplace add 8hats/marketplace
/plugin install bios-implant@8hats
```

Restart Claude Code (or `/reload-plugins`) so the MCP servers, hooks, and
skills load. Update with `/plugin marketplace update 8hats` followed by
`/plugin update bios-implant@8hats` — both commands are required. Uninstall
with `claude plugin uninstall bios-implant@8hats`.

Non-interactive provisioning via `settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "8hats": { "source": { "source": "github", "repo": "8hats/marketplace" } }
  },
  "enabledPlugins": { "bios-implant@8hats": true }
}
```

## Claude Desktop / Local Cowork — prepared

Install through the desktop app's plugin browser using the same marketplace
source, `8hats/marketplace`. Fully quit and reopen Claude Desktop after a first
install or update so the UI starts from the reconciled plugin state. Nobody
has yet driven a Local Cowork session end to end through this path, so treat
it as prepared rather than proven.

Do **not** use Settings → Connectors → *Add custom connector* for Local
Cowork: that registers the remote server alone, without the skills, the
hooks, or the local companion.

## Codex and other MCP hosts

There is no marketplace mechanism on these hosts. Per-host configuration —
Codex, hosted Claude connectors, Cursor, VS Code, Gemini CLI, Zed, Windsurf,
stdio-only hosts — lives in [`docs/multi-host.md`](../../docs/multi-host.md),
including which configurations are verified and which are prepared. Hosts
without a hook runner boot via [`AGENTS.md`](../../AGENTS.md).

## After installing — in a fresh session

1. Open a fresh session so the host loads the plugin, MCP registrations,
   hooks, and skills.
2. Run the BIOS Implant `doctor` skill.
3. Complete native OAuth only if the harness prompts for it. Never enter a
   Client ID, callback URL, scope, or other connector setting; the remote MCP
   owns discovery and automatic client registration.
4. To bind a workspace: change to the exact folder you want bound, obtain the
   owner-provided one-use setup URL, and give it only to the `connect`
   skill — never to a shell command, an installer, a log, or normal chat.
5. Run `doctor` again after binding, then `boot`.

## Status semantics

- `PASS` — the expected local state is in place.
- `WARN AUTH_REQUIRED` — local state is in place, but authenticated remote
  runtime state is not proven yet. Open a new session, run the `doctor`
  skill, and complete native OAuth only if prompted.
- `WARN BINDING_REQUIRED` — install succeeded, but the target workspace is
  not bound yet. Obtain the owner-provided one-use setup URL, open the
  intended folder, and give that secret only to the `connect` skill there.
- `WARN RUNTIME_PROBE_REQUIRED` — local checks cannot prove authenticated
  runtime health. Open a new session and run the `doctor` skill.
- `FAIL` — the expected contract did not complete; repair before use.

## Repair

Reinstalling from the marketplace is the repair path: run the update pair
(or uninstall and install again), restart the host session, and re-run the
`doctor` skill. Skills, hooks, and both MCP registrations are reconciled by
the host's own plugin machinery — no separate installer exists.

## Troubleshooting

- **Node too old** — the local companion needs Node ≥ 20 on `PATH`; check
  with `node --version`.
- **`doctor` reports `AUTH_REQUIRED`** — open a new session, run the `doctor`
  skill, complete native OAuth only when prompted.
- **`doctor` reports `BINDING_REQUIRED`** — obtain the owner-provided one-use
  setup URL, open the intended project folder, and give it only to the
  `connect` skill from that exact folder.
- **`doctor` reports `RUNTIME_PROBE_REQUIRED`** — open a new session and run
  the `doctor` skill.
- **Codex does not boot BIOS automatically** — expected: Codex has no hook
  runner. Run the `boot` skill manually at session start, per `AGENTS.md`.
- **A machine still carries the retired npx-era install**
  (`bios-implant@agent-university`, frozen at the last npm release) — remove
  it, then install from the marketplace: `claude plugin uninstall
  bios-implant@agent-university`, `claude plugin install bios-implant@8hats`.
  Running both copies means duplicate skills and duplicate MCP servers.
