# One-prompt install

Everything below the line is **the product**: one block of text a person pastes into
whatever agent they already have open. The agent works out which harness it is running
in, installs BIOS Implant the way that harness actually takes an install, and finishes
by proving the thing is alive.

Verified on **Claude Code**. Prepared for **Claude Desktop / Local Cowork** and
**Qwen Code** — see [What is verified and what is not](#what-is-verified-and-what-is-not)
before promising either of those to anyone.

Other hosts (Codex, Cursor, VS Code, Zed, Windsurf, plain stdio) are not in the prompt on
purpose: they have no install to automate, only configuration. Send those to
[`multi-host.md`](multi-host.md).

---

## The prompt

````text
Install the 8Hats BIOS Implant into the agent harness you are running in, then prove it
is live. Work through the steps in order. Do not skip the identification step and do not
improvise an install path that is not listed here.

STEP 1 — IDENTIFY THE HARNESS. Check, do not assume.
  - Claude Code:  the environment variable CLAUDECODE is set, or `claude` is on PATH.
  - Qwen Code:    `qwen` is on PATH, or a ~/.qwen directory exists.
  - Claude Desktop / Local Cowork: you cannot run shell commands at all, or you can and
    a Claude Desktop profile directory exists (on macOS
    ~/Library/Application Support/Claude; on Windows and Linux the equivalent
    application-data location).
  If you cannot run shell commands, take the Claude Desktop branch — that is the
  GUI-only case.
  If nothing matches, say so plainly and stop. Do not invent a fourth path.

STEP 2 — INSTALL. Take exactly one branch.

  (A) CLAUDE CODE — you can do this yourself.
      Run:
        claude plugin marketplace add 8hats/marketplace
        claude plugin install bios-implant@8hats
      Then check for the retired npm-era copy and remove it if it is there, because two
      copies mean duplicated skills and duplicated MCP servers:
        claude plugin list
        claude plugin uninstall bios-implant@agent-university     # only if listed
      Confirm what landed:
        claude plugin details bios-implant
      You should see skills (boot, connect, doctor, hello, install), one SessionStart
      hook, and the MCP servers. Then tell the person to restart the session: plugins
      load at session start, so nothing you just installed exists in this one.

  (B) CLAUDE DESKTOP / LOCAL COWORK — you cannot do this yourself. Walk the person
      through it, one instruction at a time, and wait for them after each:
        1. Settings, then the plugin browser (Extensions).
        2. Add a marketplace with the source:  8hats/marketplace
        3. Install "bios-implant" from that marketplace.
        4. Quit Claude Desktop completely — the whole application, not just the window —
           and open it again.
      Tell them NOT to use Settings > Connectors > "Add custom connector". That
      registers the remote server on its own, without the skills, the hook, or the local
      companion, and it looks like it worked.

  (C) QWEN CODE — there is no marketplace here, so this is a clone plus configuration.
      First check the runtime and stop if it is too old:
        node --version            # must be 20 or newer
      Then:
        1. Get the tree:
             git clone --depth 1 https://github.com/8hats/marketplace ~/.8hats/marketplace
           If that directory already exists instead run:
             git -C ~/.8hats/marketplace pull --ff-only
        2. Merge these entries into ~/.qwen/settings.json. Create the file if it is
           missing; if it exists, keep every key already in it and only add these:
             {
               "mcpServers": {
                 "implant": {
                   "httpUrl": "https://implant.agents.university/mcp"
                 },
                 "implant-local": {
                   "command": "node",
                   "args": ["/ABSOLUTE/PATH/TO/HOME/.8hats/marketplace/plugins/bios-implant/dist/local-mcp.mjs"]
                 }
               }
             }
           Substitute the real absolute home path. A "~" inside that args string is not
           expanded and the server will fail to start.
        3. Qwen Code has no session-start hook, so the boot instruction has to live in
           context. Copy the contents of ~/.8hats/marketplace/AGENTS.md into
           ~/.qwen/QWEN.md (append it if that file already has content).
        4. Restart qwen.

STEP 3 — PROVE IT, in a fresh session.
      Say:  hey implant
      A live implant answers with a greeting followed by its own evidence — companion
      version, the bound agent, the folder, the staged BIOS version.
      Read the answer carefully:
        - greeting WITH an evidence line   -> the implant is running.
        - greeting with NO evidence line   -> nothing is running and something just
                                              repeated the phrase back at you. Not a pass.
        - no answer at all                 -> run the `doctor` skill and follow it.

STEP 4 — BIND THE FOLDER.
      Installation does not bind anything. Binding needs a one-use setup URL that only
      the agent's owner can issue. Ask them for it, change to the exact folder that
      should be bound, and give the URL only to the `connect` skill from that folder —
      never to a shell command, an installer, a log, or ordinary chat. Then run `doctor`
      again, then `boot`.
````

---

## What is verified and what is not

| Branch | State | What was actually done |
|---|---|---|
| **(A) Claude Code** | **verified** | The commands were run verbatim, non-interactively, in an isolated `CLAUDE_CONFIG_DIR` sandbox on CC 2.1.228 — twice. Once against `8hats/marketplace` on GitHub as a person would type it: marketplace added, `bios-implant@8hats` 1.0.20 installed and enabled, `plugin details` listing 4 skills + 1 SessionStart hook, `claude mcp list` showing `implant-local` connected over stdio and `implant` reaching its auth challenge. Once against this branch's tree, where the inventory is 5 skills (`hello` included). Not exercised: the `agent-university` uninstall line — no machine here carries that retired install. |
| **(B) Claude Desktop** | **prepared** | The click path is the documented one and matches `INSTALL.md`; nobody has driven it end to end from this repository. The marketplace-sync fix it depends on is [#1](https://github.com/8hats/marketplace/pull/1), still open. |
| **(C) Qwen Code** | **prepared** | The config shape is from Qwen Code's own documentation (`~/.qwen/settings.json`, `mcpServers`, `httpUrl` for streamable HTTP, `command`/`args` for stdio). Not executed: nobody has run `qwen` against this tree. Remote OAuth on Qwen is the open question — the IdP has Dynamic Client Registration live, but no round-trip has been completed from a Gemini-CLI-family host. Until one is, expect the **local** companion to work and the **remote** `implant` server to need attention. |

## Why the prompt is shaped this way

- **It refuses rather than improvises.** A wrong branch installs something that half-works
  and reports success, which is worse than stopping. Hence "say so plainly and stop".
- **"You cannot run shell commands" is the Desktop signal**, not a path test. It is the one
  check that cannot be wrong about what the agent is able to do.
- **Step 3 tells the reader how to reject a false pass.** The greeting alone is not proof —
  it can be parroted by any model that has read this document. The evidence line cannot be.
  That is the whole reason `local_hello` returns live state rather than a fixed string.
- **Step 4 is separate on purpose.** Installing is not binding, and the two get conflated
  constantly. The setup URL is a one-use capability; the prompt names the exact ways it
  must not be handled.
