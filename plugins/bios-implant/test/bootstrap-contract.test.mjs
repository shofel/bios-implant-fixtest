import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function readPackageFile(...segments) {
  return fsp.readFile(path.join(packageRoot, ...segments), "utf8");
}

test("README exposes an autonomous Local Cowork bootstrap contract", async () => {
  const readme = await readPackageFile("README.md");

  assert.match(readme, /## Agent bootstrap for Local Cowork/);
  assert.match(readme, /https:\/\/app\.agents\.university\/bios-implant\/SETUP\.md/);
  assert.match(readme, /fetch and follow the public setup document first/i);
  assert.match(readme, /Remote Cowork: not supported/i);
  assert.match(readme, /\/plugin marketplace add 8hats\/marketplace/);
  assert.match(readme, /\/plugin install bios-implant@8hats/);
  assert.match(readme, /skills\/install\/SKILL\.md/);
  assert.doesNotMatch(readme, /npx -y/);
});

test("install skill owns the marketplace install, doctor, and handoff workflow", async () => {
  const skill = await readPackageFile("skills", "install", "SKILL.md");
  const metadata = await readPackageFile("skills", "install", "agents", "openai.yaml");

  assert.match(skill, /^---\nname: install\n/m);
  assert.match(skill, /Local Cowork/);
  assert.match(skill, /8hats\/marketplace/);
  assert.match(skill, /claude plugin install bios-implant@8hats/);
  assert.match(skill, /Never install through\s+npm or npx/i);
  assert.match(skill, /AUTH_REQUIRED/);
  assert.match(skill, /BINDING_REQUIRED/);
  assert.match(skill, /fresh session/i);
  assert.doesNotMatch(skill, /npx -y/);
  assert.match(metadata, /default_prompt: ".*\$install/);
});

test("Cowork receives the native post-install SETUP.md skill", async () => {
  const setup = await readPackageFile("SETUP.md");

  assert.match(setup, /^# BIOS Implant Setup/m);
  assert.match(setup, /Local Cowork/);
  assert.match(setup, /Node is version 20 or newer/);
  assert.match(setup, /8hats\/marketplace/);
  assert.match(setup, /plugin browser/i);
  assert.doesNotMatch(setup, /COWORK_CONFIRMATION_REQUIRED/);
  assert.doesNotMatch(setup, /claude:\/\/cowork\/new/);
  assert.doesNotMatch(setup, /npx -y/);
  assert.match(setup, /doctor/);
  assert.match(setup, /OAuth/);
  assert.match(setup, /connect/);
  assert.match(setup, /one-use setup URL/);
  assert.match(setup, /READY/);
  assert.match(setup, /INSTALLED/);
  assert.match(setup, /BLOCKED/);
});

test("the plugin manifest, the package manifest, and the runtime constant report ONE version", async () => {
  // "Which version am I running" had two answers through 1.0.16. The host and the marketplace read
  // .claude-plugin/plugin.json (1.0.16), while everything the agent can actually observe at runtime
  // comes from PACKAGE_VERSION in constants.mjs (1.0.15) — LOCAL_MCP_SERVER_VERSION feeds
  // serverInfo.version, so the companion announced itself over MCP as `implant-local 1.0.15`, and
  // doctor's own manifest-version check compared against that stale constant.
  //
  // Asserted across all three sources rather than "package.json matches plugin.json", because the
  // release commits that caused this (3ab70c4, 1a21c4c) touched plugin.json alone: any pairwise
  // check leaves a third surface free to drift.
  const plugin = JSON.parse(await readPackageFile(".claude-plugin", "plugin.json"));
  const manifest = JSON.parse(await readPackageFile("package.json"));
  const constants = await readPackageFile("src", "constants.mjs");
  const runtime = /export const PACKAGE_VERSION = "([^"]+)"/u.exec(constants)?.[1];

  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, plugin.version);
  assert.equal(runtime, plugin.version);
});

test("package metadata advertises the Cowork installer rather than a generic package shell", async () => {
  const manifest = JSON.parse(await readPackageFile("package.json"));

  assert.match(manifest.description, /Local Cowork/i);
  assert.match(manifest.description, /install/i);
});

test("the marketplace plugin ships no top-level bin/ — claude.ai-hosted plugins reject it", async () => {
  // Claude Desktop syncs claude.ai-hosted marketplace plugins through a validator that fails the
  // whole marketplace (MARKETPLACE_ERROR:REMOTE_SYNC_FAILED / failed_content) when a plugin ships a
  // top-level bin/ directory. Claude Code tolerates bin/, so the CLI synced while Desktop did not.
  // This plugin's real entry points are declared through mcpServers/hooks/skills, so a bin/ here is
  // npm-package cruft — keep it out of the marketplace tree, and out of the npm package's files[].
  const manifest = JSON.parse(await readPackageFile("package.json"));

  assert.equal(manifest.bin, undefined, "package.json must not declare a bin field");
  assert.ok(!(manifest.files ?? []).includes("bin/"), "package.json files[] must not ship bin/");
  await assert.rejects(
    fsp.stat(path.join(packageRoot, "bin")),
    /ENOENT/u,
    "no top-level bin/ directory may exist in the plugin tree"
  );
});

test("doctor skill requires runtime evidence and a human-readable health table", async () => {
  const skill = await readPackageFile("skills", "doctor", "SKILL.md");

  assert.match(skill, /resolve tools by capability.*not by server display name/i);
  assert.match(skill, /Do not report missing authentication from.*pending.*needs.auth/i);
  assert.match(skill, /actual `bios_load` call returns an authentication error/i);
  assert.match(skill, /Do not claim that local state is healthy when the local probes did not run/i);
  assert.match(skill, /\| Check \| Status \| Evidence \|/);
  assert.match(skill, /✅ PASS/);
  assert.match(skill, /⚠️ PARTIAL/);
  assert.match(skill, /❌ FAIL/);
  assert.match(skill, /⏭️ NOT CHECKED/);
});

test("boot skill ties the status to the agent's knowledge, and bans credential archaeology", async () => {
  const skill = await readPackageFile("skills", "boot", "SKILL.md");

  // A config-K agent carries its knowledge inside the BIOS body and never needs wm_load. The old
  // rule downgraded any wm_load failure to PARTIAL unconditionally, so such an agent reported
  // itself degraded while holding a complete firmware — telling the user it could not answer about
  // the organization when it could.
  assert.match(skill, /whether the agent HAS the knowledge its BIOS names, not by whether this tool answered/);
  assert.match(skill, /A BIOS that carries its own knowledge does not need `wm_load`/);
  assert.match(skill, /`wm_load` is not required for such an agent/);

  // On 2026-08-10 an opaque `unauthorized` from wm_load sent a booted agent reading the macOS
  // keychain for Claude Code's OAuth credentials. The harness classifier stopped it; the skill
  // said nothing either way, which is the gap this pins.
  assert.match(skill, /Never inspect credential storage/);
  assert.match(skill, /no keychain reads/);
  assert.doesNotMatch(skill, /If `wm_load` fails, keep the BIOS result and report a partial boot\./);
});

test("connect skill routes one-use activation through the native local companion", async () => {
  const skill = await readPackageFile("skills", "connect", "SKILL.md");

  assert.match(skill, /Pass the owner-provided setup URL exactly once to `local_activate`/);
  assert.match(skill, /perform its single activation request from the native host/);
  assert.match(skill, /do not reconstruct or run its `curl` command/i);
  assert.match(skill, /Never use workspace shell, `curl`, Web Fetch, or browser automation for activation/);
});

test("remote authorization goes through the host plugin UI, never a pasted authorization URL", async () => {
  // MEOW-20, 2026-08-11: the agent called the harness-injected `authenticate` tool and relayed
  // its URL into chat; the owner authorized through /plugin instead, which minted its OWN DCR
  // client and callback port — the pasted URL's PKCE challenge was already dead. The skills must
  // name the UI path as THE action and ban both the tool call and the URL relay, in boot (where
  // an unauthorized bios_load surfaces) and in connect (whose REMOTE-AUTH owns the recovery).
  const connect = await readPackageFile("skills", "connect", "SKILL.md");
  const boot = await readPackageFile("skills", "boot", "SKILL.md");

  for (const [name, skill] of [["connect", connect], ["boot", boot]]) {
    assert.match(skill, /\/plugin/, `${name} names the /plugin UI`);
    assert.match(skill, /Authenticate/, `${name} names the Authenticate action`);
    assert.match(skill, /plugin browser/i, `${name} covers the Claude Desktop surface`);
    assert.match(skill, /`authenticate` tool/, `${name} names the harness tool it bans`);
    assert.match(
      skill,
      /[Nn]ever (?:call|relay|print)[^.\n]*(?:`authenticate` tool|authorization URL)/,
      `${name} bans the authenticate tool / URL relay`,
    );
    assert.match(skill, /challenge that cannot complete/, `${name} states WHY the pasted URL is dead`);
  }

  // The UI path is primary: the no-TTY pty recipe must be scoped to surfaces with no plugin UI,
  // not offered as the default.
  assert.match(connect, /Only when no plugin UI exists/);
  // Mid-session authorization never surfaces the remote tools — the restart step must survive.
  assert.match(connect, /start a fresh session and run the `boot` skill/);
  assert.match(boot, /mid-session authorization never surfaces the remote tools/);
});

test("every Codex skill prompt names its skill", async () => {
  for (const skill of ["boot", "connect", "doctor", "install"]) {
    const metadata = await readPackageFile("skills", skill, "agents", "openai.yaml");
    assert.match(metadata, new RegExp(`default_prompt: ".*\\$${skill}\\b`));
  }
});
