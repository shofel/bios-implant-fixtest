import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.mjs";
import { probeLocalCompanion } from "../src/doctor.mjs";
import { PACKAGE_VERSION } from "../src/constants.mjs";

const DEFAULT_TEST_REPORT_ROOT = path.join(os.tmpdir(), `bios-implant-cli-tests-${process.pid}`);
const ANSI_PATTERN = /\u001B\[[0-9;]*m/gu;

function createOutputBuffers() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    writer: {
      reportRoot: DEFAULT_TEST_REPORT_ROOT,
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk)
    }
  };
}

function jsonResult(stdout) {
  return JSON.parse(stdout.join(""));
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function createDoctorFixture({ withBinding = true } = {}) {
  const packageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-pkg-"));
  const homeDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-home-"));
  const stateRoot = path.join(homeDirectory, "custom-state-root");
  const bundledMarketplacePath = path.join(packageRoot, "catalog", ".claude-plugin", "marketplace.json");
  const persistentMarketplacePath = path.join(stateRoot, "bios-implant", "catalog", ".claude-plugin", "marketplace.json");

  await writeJson(path.join(packageRoot, ".claude-plugin", "plugin.json"), {
    name: "bios-implant",
    version: PACKAGE_VERSION,
    skills: "./skills/",
    hooks: "./hooks/claude.json",
    mcpServers: {
      implant: {
        type: "http",
        url: "https://implant.agents.university/mcp"
      },
      "implant-local": {
        type: "stdio",
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/dist/local-mcp.mjs"]
      }
    }
  });
  await writeJson(path.join(packageRoot, ".claude-plugin", "marketplace.json"), {
    name: "agent-university",
    owner: { name: "Agent University" },
    plugins: [{ name: "bios-implant", source: "./" }]
  });
  await writeJson(path.join(packageRoot, ".codex-plugin", "plugin.json"), {
    name: "bios-implant",
    version: PACKAGE_VERSION,
    skills: "./skills/",
    mcpServers: "./.mcp.json"
  });
  await writeJson(path.join(packageRoot, ".mcp.json"), {
    mcpServers: {
      "implant-local": {
        type: "stdio",
        command: "node",
        args: ["dist/local-mcp.mjs"],
        cwd: "${CODEX_PLUGIN_ROOT}"
      }
    }
  });
  await writeJson(bundledMarketplacePath, {
    name: "agent-university",
    owner: {
      name: "Agent University"
    },
    plugins: [{
      name: "bios-implant",
      source: {
        source: "npm",
        package: "@agentuniversity/bios-implant"
      }
    }]
  });
  await writeJson(persistentMarketplacePath, {
    name: "agent-university",
    owner: {
      name: "Agent University"
    },
    plugins: [{
      name: "bios-implant",
      source: {
        source: "npm",
        package: "@agentuniversity/bios-implant"
      }
    }]
  });

  const textArtifacts = [
    path.join(packageRoot, "dist", "local-mcp.mjs"),
    path.join(packageRoot, "SETUP.md"),
    path.join(packageRoot, "skills", "install", "SKILL.md"),
    path.join(packageRoot, "skills", "connect", "SKILL.md"),
    path.join(packageRoot, "skills", "boot", "SKILL.md"),
    path.join(packageRoot, "skills", "doctor", "SKILL.md"),
    path.join(packageRoot, "hooks", "claude.json"),
    path.join(packageRoot, "hooks", "codex.json"),
    path.join(packageRoot, "scripts", "boot-protocol.mjs")
  ];

  for (const filePath of textArtifacts) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, "fixture\n", "utf8");
  }

  await writeJson(path.join(stateRoot, "bios-implant", "install-state.json"), {
    managed: true
  });

  if (withBinding) {
    await writeJson(
      path.join(stateRoot, "bios", "projects", "workspace-1", "binding.json"),
      { folder: "/workspace/demo", agent_id: "agent-1" }
    );
  }

  return { packageRoot, homeDirectory, stateRoot };
}

function healthyDetection() {
  const claudeDetection = {
    harness: "claude",
    detected: true,
    supported: true,
    executable: "/Users/tester/.local/bin/claude",
    version: "2.0.0",
    required_version: "1.0.0",
    upgrade_required: false,
    app_present: false
  };
  return {
    detections: [claudeDetection],
    byHarness: {
      claude: claudeDetection
    }
  };
}

function healthyHarnessDoctor() {
  return { checks: [{ code: "HARNESS_PLUGIN_PRESENT", result: "PASS", evidence: { path: "/Users/tester/.config/claude" } }] };
}

function healthyLocalCompanionProbe() {
  return {
    code: "LOCAL_COMPANION_HANDSHAKE",
    result: "PASS",
    evidence: {
      server_name: "implant-local",
      version: PACKAGE_VERSION
    }
  };
}

test("host doctor performs a real Local Companion initialize and tools handshake", async () => {
  const check = await probeLocalCompanion(path.resolve("."), { timeoutSeconds: 2 });
  assert.equal(check.result, "PASS");
  assert.equal(check.evidence.server_name, "implant-local");
  assert.deepEqual(check.evidence.tools, [
    "local_activate",
    "local_connect",
    "local_doctor",
    "local_hello",
    "local_selection",
    "local_stage",
    "local_status"
  ]);
});

test("CLI parses the full public install option matrix and forced wrapper modes", async () => {
  const { stdout, stderr, writer } = createOutputBuffers();
  const installCalls = [];
  const doctorCalls = [];

  let exitCode = await runCli([
    "install",
    "--yes",
    "--dry-run",
    "--json",
    "--harness",
    "all",
    "--harness=all",
    "--harness",
    "cowork",
    "--harness",
    "claude",
    "--harness",
    "codex",
    "--timeout",
    "12.5",
    "--verbose"
  ], {
    ...writer,
    runInstaller: async (command, options) => {
      installCalls.push({ command, options });
      return { status: "PASS", version: PACKAGE_VERSION, harnesses: [], exit_code: 0 };
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].command, "install");
  assert.deepEqual(installCalls[0].options.harnesses, ["all", "cowork", "claude", "codex"]);
  assert.equal("noSelfUpdate" in installCalls[0].options, false);
  assert.equal(installCalls[0].options.timeoutSeconds, 12.5);
  assert.equal(installCalls[0].options.verbose, true);
  assert.equal("openCowork" in installCalls[0].options, false);

  stdout.length = 0;
  exitCode = await runCli(["--json"], {
    ...writer,
    forcedCommand: "doctor",
    runDoctor: async (options) => {
      doctorCalls.push(options);
      return { status: "WARN", version: PACKAGE_VERSION, checks: [], warnings: [], next_steps: [], exit_code: 2 };
    }
  });

  assert.equal(exitCode, 2);
  assert.equal(doctorCalls.length, 1);
  assert.equal(doctorCalls[0].json, true);
});

test("CLI rejects invalid command inputs strictly", async () => {
  const invalidCases = [
    { argv: [], message: "A command is required." },
    { argv: ["nope"], message: "Unknown command: nope" },
    { argv: ["doctor", "--harness", "bad"], message: "Unsupported harness: bad" },
    { argv: ["doctor", "--timeout", "0"], message: "--timeout must be between 1 and 300 seconds" },
    { argv: ["doctor", "--timeout", "301"], message: "--timeout must be between 1 and 300 seconds" },
    { argv: ["install", "--timeout"], message: "Missing value after --timeout" },
    { argv: ["install", "--harness"], message: "Missing value after --harness" },
    { argv: ["install", "--no-open"], message: "Unknown option: --no-open" },
    { argv: ["install", "--no-self-update"], message: "Unknown option: --no-self-update" },
    { argv: ["doctor", "--purge-data"], message: "--purge-data is only valid with uninstall" },
    { argv: ["instructions", "--yes"], message: "instructions only accepts --json, --verbose, --help, and --version" }
  ];

  for (const { argv, message } of invalidCases) {
    const { stderr, writer } = createOutputBuffers();
    const exitCode = await runCli(argv, writer);
    assert.notEqual(exitCode, 0, argv.join(" "));
    assert.match(stderr.join(""), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("mutating commands require --yes outside a TTY and cancellation does not invoke the installer", async () => {
  const nonInteractive = createOutputBuffers();
  let installerCalls = 0;
  const rejectedExit = await runCli(["install"], {
    ...nonInteractive.writer,
    runInstaller: async () => {
      installerCalls += 1;
      return { status: "PASS", version: PACKAGE_VERSION, harnesses: [], exit_code: 0 };
    }
  });
  assert.equal(rejectedExit, 64);
  assert.match(nonInteractive.stderr.join(""), /Use --yes/);
  assert.equal(installerCalls, 0);

  const cancelled = createOutputBuffers();
  const cancelledExit = await runCli(["uninstall", "--json"], {
    ...cancelled.writer,
    confirmMutation: async () => false,
    runInstaller: async () => {
      installerCalls += 1;
      return { status: "PASS", version: PACKAGE_VERSION, harnesses: [], exit_code: 0 };
    }
  });
  assert.equal(cancelledExit, 0);
  assert.equal(jsonResult(cancelled.stdout).code, "USER_CANCELLED");
  assert.equal(installerCalls, 0);
});

test("instructions prefers the install skill, falls back to INSTALL.md, and remains read-only", async () => {
  const packageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-instructions-"));
  const homeDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-home-"));
  const installPath = path.join(packageRoot, "INSTALL.md");
  const installSkillPath = path.join(packageRoot, "skills", "install", "SKILL.md");
  await fsp.mkdir(path.dirname(installSkillPath), { recursive: true });
  await fsp.writeFile(
    installSkillPath,
    "Follow the autonomous Local Cowork install skill.\n",
    "utf8"
  );
  await fsp.writeFile(
    installPath,
    "Run the host terminal installer for Claude Desktop / Local Cowork.\n",
    "utf8"
  );

  const presentOutput = createOutputBuffers();
  let exitCode = await runCli(["instructions"], {
    ...presentOutput.writer,
    packageRoot,
    homeDirectory
  });

  assert.equal(exitCode, 0);
  assert.equal(
    presentOutput.stdout.join(""),
    "Follow the autonomous Local Cowork install skill.\n\n"
  );

  await fsp.unlink(installSkillPath);
  presentOutput.stdout.length = 0;
  exitCode = await runCli(["instructions"], {
    ...presentOutput.writer,
    packageRoot,
    homeDirectory
  });

  assert.equal(exitCode, 0);
  assert.equal(
    presentOutput.stdout.join(""),
    "Run the host terminal installer for Claude Desktop / Local Cowork.\n\n"
  );

  await fsp.unlink(installPath);
  const missingOutput = createOutputBuffers();
  exitCode = await runCli(["instructions", "--json"], {
    ...missingOutput.writer,
    packageRoot,
    homeDirectory
  });

  assert.equal(exitCode, 2);
  const result = jsonResult(missingOutput.stdout);
  assert.equal(result.code, "INSTALL_INSTRUCTIONS_MISSING");
  assert.match(result.instructions, /npx -y @agentuniversity\/bios-implant@latest install --yes/);
  await assert.rejects(
    fsp.access(path.join(homeDirectory, ".agent-university", "bios-implant", "catalog")),
    { code: "ENOENT" }
  );
});

test("doctor --json maps remote probe outcomes, redacts home paths by default, and exposes probe state", async (t) => {
  const scenarios = [
    {
      name: "200 valid",
      response: {
        status: 200,
        url: "https://implant.agents.university/mcp",
        redirected: false,
        text: async () => JSON.stringify({ status: "ok" })
      },
      expectedExit: 2,
      expectedStatus: "WARN",
      expectedProbeState: "probe_pending",
      expectedCode: "RUNTIME_PROBE_REQUIRED"
    },
    {
      name: "302 redirect",
      response: {
        status: 302,
        url: "https://evil.example/mcp",
        redirected: true,
        text: async () => ""
      },
      expectedExit: 1,
      expectedStatus: "FAIL",
      expectedProbeState: "invalid",
      expectedCode: "REMOTE_CONTRACT_INVALID"
    },
    {
      name: "400 invalid",
      response: {
        status: 400,
        url: "https://implant.agents.university/mcp",
        redirected: false,
        text: async () => JSON.stringify({ error: "bad request" })
      },
      expectedExit: 1,
      expectedStatus: "FAIL",
      expectedProbeState: "invalid",
      expectedCode: "REMOTE_CONTRACT_INVALID"
    },
    {
      name: "401 auth required",
      response: {
        status: 401,
        url: "https://implant.agents.university/mcp",
        redirected: false,
        text: async () => JSON.stringify({ error: "unauthorized" })
      },
      expectedExit: 2,
      expectedStatus: "WARN",
      expectedProbeState: "auth_required",
      expectedCode: "AUTH_REQUIRED"
    },
    {
      name: "403 auth required",
      response: {
        status: 403,
        url: "https://implant.agents.university/mcp",
        redirected: false,
        text: async () => JSON.stringify({ error: "forbidden" })
      },
      expectedExit: 2,
      expectedStatus: "WARN",
      expectedProbeState: "auth_required",
      expectedCode: "AUTH_REQUIRED"
    },
    {
      name: "404 invalid",
      response: {
        status: 404,
        url: "https://implant.agents.university/mcp",
        redirected: false,
        text: async () => JSON.stringify({ error: "missing" })
      },
      expectedExit: 1,
      expectedStatus: "FAIL",
      expectedProbeState: "invalid",
      expectedCode: "REMOTE_CONTRACT_INVALID"
    },
    {
      name: "5xx warning",
      response: {
        status: 503,
        url: "https://implant.agents.university/mcp",
        redirected: false,
        text: async () => JSON.stringify({ error: "down" })
      },
      expectedExit: 2,
      expectedStatus: "WARN",
      expectedProbeState: "unreachable",
      expectedCode: "REMOTE_UNREACHABLE"
    },
    {
      name: "timeout warning",
      responseError: new Error("Remote probe timed out"),
      expectedExit: 2,
      expectedStatus: "WARN",
      expectedProbeState: "unreachable",
      expectedCode: "REMOTE_UNREACHABLE"
    },
    {
      name: "malformed 200",
      response: {
        status: 200,
        url: "https://implant.agents.university/mcp",
        redirected: false,
        text: async () => "not-json"
      },
      expectedExit: 1,
      expectedStatus: "FAIL",
      expectedProbeState: "invalid",
      expectedCode: "REMOTE_CONTRACT_INVALID"
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture();
      const { stdout, stderr, writer } = createOutputBuffers();

      const exitCode = await runCli(["doctor", "--json"], {
        ...writer,
        packageRoot,
        homeDirectory,
        env: { HOME: homeDirectory, BIOS_IMPLANT_STATE_ROOT: stateRoot, AGENT_UNIVERSITY_HOME: path.join(homeDirectory, "ignored-home") },
        detectHarnessesImpl: async () => healthyDetection(),
        doctorHarnessImpl: async () => healthyHarnessDoctor(),
        localCompanionProbe: async () => healthyLocalCompanionProbe(),
        fetchImplant: async () => {
          if (scenario.responseError) {
            throw scenario.responseError;
          }
          return scenario.response;
        }
      });

      assert.equal(exitCode, scenario.expectedExit);
      assert.equal(stderr.join(""), "");
      const result = jsonResult(stdout);
      assert.equal(result.status, scenario.expectedStatus);
      assert.equal(result.remote_probe.state, scenario.expectedProbeState);
      assert.ok(result.checks.some((check) => check.code === scenario.expectedCode));
      assert.ok(result.checks.some((check) => check.code === "BUNDLED_MARKETPLACE_OWNER_VALID"));
      assert.ok(result.checks.some((check) => check.code === "BUNDLED_MARKETPLACE_SOURCE_VALID"));
      assert.ok(result.checks.some((check) => check.code === "PERSISTENT_MARKETPLACE_OWNER_VALID"));
      assert.ok(result.checks.some((check) => check.code === "PERSISTENT_MARKETPLACE_SOURCE_VALID"));
      assert.equal(result.version, PACKAGE_VERSION);
      const serializedWithoutReportLocation = stdout.join("")
        .replaceAll(result.report_file, "<report-file>")
        .replaceAll(result.report_url, "<report-url>");
      assert.ok(!serializedWithoutReportLocation.includes(homeDirectory));
      assert.ok(!serializedWithoutReportLocation.includes(stateRoot));
      assert.ok(!serializedWithoutReportLocation.includes(packageRoot));
      assert.ok(!serializedWithoutReportLocation.includes("/Users/tester/.local/bin/claude"));
    });
  }
});

test("doctor exposes raw paths only with --verbose", async () => {
  const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture({ withBinding: false });
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor", "--json", "--verbose"], {
    ...writer,
    packageRoot,
    homeDirectory,
    env: { HOME: homeDirectory, BIOS_IMPLANT_STATE_ROOT: stateRoot },
    detectHarnessesImpl: async () => healthyDetection(),
    doctorHarnessImpl: async () => healthyHarnessDoctor(),
    localCompanionProbe: async () => healthyLocalCompanionProbe(),
    fetchImplant: async () => ({
      status: 401,
      url: "https://implant.agents.university/mcp",
      redirected: false,
      text: async () => JSON.stringify({ error: "unauthorized" })
    })
  });

  assert.equal(exitCode, 2);
  assert.ok(stdout.join("").includes(stateRoot));
  const result = jsonResult(stdout);
  const bindingWarning = result.warnings.find((warning) => warning.code === "BINDING_REQUIRED");
  assert.match(bindingWarning.message, /owner-provided one-use setup URL/);
  assert.match(bindingWarning.message, /only to the connect skill/);
  assert.match(bindingWarning.message, /never give it to the installer or doctor/);
  assert.ok(result.next_steps.includes(bindingWarning.message));
});

test("doctor rejects embedded Claude OAuth client settings", async () => {
  const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture();
  await writeJson(path.join(packageRoot, ".claude-plugin", "plugin.json"), {
    name: "bios-implant",
    version: PACKAGE_VERSION,
    skills: "./skills/",
    hooks: "./hooks/claude.json",
    mcpServers: {
      implant: {
        type: "http",
        url: "https://implant.agents.university/mcp",
        oauth: {
          clientId: "bios-implant",
          callbackPort: 8484
        }
      },
      "implant-local": {
        type: "stdio",
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/dist/local-mcp.mjs"]
      }
    }
  });
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor", "--json"], {
    ...writer,
    packageRoot,
    homeDirectory,
    env: { HOME: homeDirectory, BIOS_IMPLANT_STATE_ROOT: stateRoot },
    detectHarnessesImpl: async () => healthyDetection(),
    doctorHarnessImpl: async () => healthyHarnessDoctor(),
    localCompanionProbe: async () => healthyLocalCompanionProbe(),
    fetchImplant: async () => ({
      status: 401,
      url: "https://implant.agents.university/mcp",
      redirected: false,
      text: async () => JSON.stringify({ error: "unauthorized" })
    })
  });

  assert.equal(exitCode, 1);
  const result = jsonResult(stdout);
  const check = result.checks.find((entry) => entry.code === "CLAUDE_MCP_CONFIG_VALID");
  assert.equal(check?.result, "FAIL");
  assert.equal(check?.evidence?.observed?.oauth_discovery, "embedded-client-settings");
});

test("non-verbose JSON redacts absolute paths anywhere while preserving URLs and stable npm commands", async () => {
  const { stdout, writer } = createOutputBuffers();
  const homeDirectory = "/Users/alice";
  const npmCommand = "npx -y @agentuniversity/bios-implant@latest install --yes";
  const remoteUrl = "https://implant.agents.university/mcp";

  const exitCode = await runCli(["doctor", "--json"], {
    ...writer,
    homeDirectory,
    packageRoot: "/opt/bios-implant",
    runDoctor: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      checks: [{
        code: "EMBEDDED_PATHS",
        result: "WARN",
        evidence: {
          message: `Failed at /private/tmp/bios/secret.json after reading ${homeDirectory}/.config/bios.json.`,
          command: "node /opt/bios-implant/dist/local-mcp.mjs --config=/var/lib/bios/private.json",
          quoted_path: "Open '/Applications/Agent University/secret.json' to continue.",
          windows_path: "Read C:\\Users\\alice\\AppData\\Local\\bios\\secret.json next.",
          remote_url: remoteUrl,
          repair_command: npmCommand
        }
      }],
      warnings: [],
      next_steps: [npmCommand],
      exit_code: 2
    })
  });

  assert.equal(exitCode, 2);
  const serialized = stdout.join("");
  assert.ok(!serialized.includes("/private/tmp/bios"));
  assert.ok(!serialized.includes("/opt/bios-implant"));
  assert.ok(!serialized.includes("/var/lib/bios"));
  assert.ok(!serialized.includes("/Applications/Agent University"));
  assert.ok(!serialized.includes("C:\\Users\\alice"));
  assert.ok(!serialized.includes(homeDirectory));
  assert.match(serialized, /<absolute>/);
  assert.ok(serialized.includes(remoteUrl));
  assert.ok(serialized.includes(npmCommand));
});

test("doctor redaction preserves prose slash separators while hiding real absolute paths", async () => {
  const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture();
  const { stdout, writer } = createOutputBuffers();
  const prose = "Use Claude Desktop / Local Cowork.";
  const secretPath = "/private/tmp/doctor-secret.json";

  const exitCode = await runCli(["doctor", "--json", "--harness", "claude"], {
    ...writer,
    packageRoot,
    homeDirectory,
    env: { HOME: homeDirectory, BIOS_IMPLANT_STATE_ROOT: stateRoot },
    detectHarnessesImpl: async () => healthyDetection(),
    doctorHarnessImpl: async () => ({
      checks: [{
        code: "DOCTOR_REDACTION_FIXTURE",
        result: "WARN",
        evidence: { message: `${prose} Inspect ${secretPath}.` }
      }]
    }),
    localCompanionProbe: async () => healthyLocalCompanionProbe(),
    fetchImplant: async () => ({
      status: 401,
      url: "https://implant.agents.university/mcp",
      redirected: false,
      text: async () => JSON.stringify({ error: "unauthorized" })
    })
  });

  assert.equal(exitCode, 2);
  const serialized = stdout.join("");
  assert.ok(serialized.includes(prose), serialized);
  assert.ok(!serialized.includes(secretPath));
  assert.match(serialized, /<absolute>/);
});

test("doctor keeps missing-harness exit 3 stable across auto and explicit detection matrices", async (t) => {
  function detectedHarnesses(...harnesses) {
    const detections = harnesses.map((harness) => ({
      harness,
      detected: true,
      supported: true,
      executable: `/usr/local/bin/${harness}`,
      version: "1.0.0"
    }));
    return {
      detections,
      byHarness: Object.fromEntries(detections.map((detection) => [detection.harness, detection]))
    };
  }

  const scenarios = [
    {
      name: "auto with no detected harnesses",
      argv: ["doctor", "--json"],
      detections: detectedHarnesses(),
      expectedExit: 3,
      expectedStatus: "WARN",
      expectedMissingResult: null
    },
    {
      name: "explicit harness is not detected",
      argv: ["doctor", "--json", "--harness", "claude"],
      detections: detectedHarnesses(),
      expectedExit: 3,
      expectedStatus: "FAIL",
      expectedMissingResult: "FAIL"
    },
    {
      name: "explicit harness is absent while another harness is detected",
      argv: ["doctor", "--json", "--harness", "claude"],
      detections: detectedHarnesses("codex"),
      expectedExit: 3,
      expectedStatus: "FAIL",
      expectedMissingResult: "FAIL"
    },
    {
      name: "auto-selected harness disappears before its doctor check",
      argv: ["doctor", "--json"],
      detections: detectedHarnesses("claude"),
      forceMissing: true,
      expectedExit: 3,
      expectedStatus: "WARN",
      expectedMissingResult: "WARN"
    },
    {
      name: "one explicit harness passes and one is not detected",
      argv: ["doctor", "--json", "--harness", "claude", "--harness", "codex"],
      detections: detectedHarnesses("claude"),
      expectedExit: 3,
      expectedStatus: "FAIL",
      expectedMissingResult: "FAIL"
    },
    {
      name: "hard remote contract failure supersedes missing harness",
      argv: ["doctor", "--json", "--harness", "claude"],
      detections: detectedHarnesses(),
      hardRemoteFailure: true,
      expectedExit: 1,
      expectedStatus: "FAIL",
      expectedMissingResult: "FAIL"
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture();
      const { stdout, writer } = createOutputBuffers();
      const exitCode = await runCli(scenario.argv, {
        ...writer,
        packageRoot,
        homeDirectory,
        env: { HOME: homeDirectory, BIOS_IMPLANT_STATE_ROOT: stateRoot },
        detectHarnessesImpl: async () => scenario.detections,
        doctorHarnessImpl: async ({ harness, detection }) => {
          if (!detection?.detected || scenario.forceMissing) {
            return {
              harness,
              result: "SKIP",
              code: "HARNESS_NOT_DETECTED",
              message: `${harness} not detected.`,
              checks: []
            };
          }
          return healthyHarnessDoctor();
        },
        localCompanionProbe: async () => healthyLocalCompanionProbe(),
        fetchImplant: async () => scenario.hardRemoteFailure
          ? {
              status: 302,
              url: "https://evil.example/mcp",
              redirected: true,
              text: async () => ""
            }
          : {
              status: 401,
              url: "https://implant.agents.university/mcp",
              redirected: false,
              text: async () => JSON.stringify({ error: "unauthorized" })
            }
      });

      assert.equal(exitCode, scenario.expectedExit);
      const result = jsonResult(stdout);
      assert.equal(result.status, scenario.expectedStatus);
      const missingCheck = result.checks.find((check) => check.code === "HARNESS_NOT_DETECTED");
      if (scenario.expectedMissingResult === null) {
        assert.equal(missingCheck, undefined);
      } else {
        assert.equal(missingCheck.result, scenario.expectedMissingResult);
      }
    });
  }
});

test("doctor without --harness checks every detected supported harness", async () => {
  const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture();
  const { stdout, writer } = createOutputBuffers();
  const calledHarnesses = [];

  const exitCode = await runCli(["doctor", "--json"], {
    ...writer,
    packageRoot,
    homeDirectory,
    env: { HOME: homeDirectory, BIOS_IMPLANT_STATE_ROOT: stateRoot },
    detectHarnessesImpl: async () => ({
      detections: [
        { harness: "claude", detected: true, supported: true, executable: "/usr/local/bin/claude", version: "2.0.0" },
        { harness: "codex", detected: true, supported: true, executable: "/usr/local/bin/codex", version: "0.146.0" }
      ],
      byHarness: {
        claude: { harness: "claude", detected: true, supported: true, executable: "/usr/local/bin/claude", version: "2.0.0" },
        codex: { harness: "codex", detected: true, supported: true, executable: "/usr/local/bin/codex", version: "0.146.0" },
        cowork: { harness: "cowork", detected: true, supported: false, executable: "/usr/local/bin/claude", version: "2.0.0", app_present: false }
      }
    }),
    doctorHarnessImpl: async ({ harness }) => {
      calledHarnesses.push(harness);
      return {
        harness,
        result: "PASS",
        code: "OK",
        checks: [{ code: `${harness.toUpperCase()}_OK`, result: "PASS", evidence: {} }]
      };
    },
    localCompanionProbe: async () => healthyLocalCompanionProbe(),
    fetchImplant: async () => ({
      status: 401,
      url: "https://implant.agents.university/mcp",
      redirected: false,
      text: async () => JSON.stringify({ error: "unauthorized" })
    })
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(calledHarnesses, ["claude", "codex"]);
  const result = jsonResult(stdout);
  assert.deepEqual(result.requested_harnesses, ["auto"]);
  assert.deepEqual(
    result.checks.filter((check) => check.harness).map((check) => check.harness),
    ["claude", "codex"]
  );
});

test("doctor without --harness also checks supported Local Cowork synthesized in byHarness", async () => {
  const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture();
  const { stdout, writer } = createOutputBuffers();
  const calledHarnesses = [];

  const exitCode = await runCli(["doctor", "--json"], {
    ...writer,
    packageRoot,
    homeDirectory,
    env: { HOME: homeDirectory, BIOS_IMPLANT_STATE_ROOT: stateRoot },
    detectHarnessesImpl: async () => ({
      detections: [
        { harness: "claude", detected: true, supported: true, executable: "/usr/local/bin/claude", version: "2.0.0" },
        { harness: "codex", detected: true, supported: true, executable: "/usr/local/bin/codex", version: "0.146.0" }
      ],
      byHarness: {
        claude: { harness: "claude", detected: true, supported: true, executable: "/usr/local/bin/claude", version: "2.0.0" },
        codex: { harness: "codex", detected: true, supported: true, executable: "/usr/local/bin/codex", version: "0.146.0" },
        cowork: {
          harness: "cowork",
          detected: true,
          supported: true,
          executable: "/usr/local/bin/claude",
          version: "2.0.0",
          app_present: true
        }
      }
    }),
    doctorHarnessImpl: async ({ harness }) => {
      calledHarnesses.push(harness);
      return {
        harness,
        result: "PASS",
        code: "OK",
        checks: [{ code: `${harness.toUpperCase()}_OK`, result: "PASS", evidence: {} }]
      };
    },
    localCompanionProbe: async () => healthyLocalCompanionProbe(),
    fetchImplant: async () => ({
      status: 401,
      url: "https://implant.agents.university/mcp",
      redirected: false,
      text: async () => JSON.stringify({ error: "unauthorized" })
    })
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(calledHarnesses, ["claude", "codex", "cowork"]);
  const result = jsonResult(stdout);
  assert.deepEqual(result.requested_harnesses, ["auto"]);
  assert.equal(result.detected_harnesses_by_name.cowork.supported, true);
  assert.deepEqual(
    result.checks.filter((check) => check.harness).map((check) => check.harness),
    ["claude", "codex", "cowork"]
  );
});

test("operational JSON mode persists a secure report and keeps stdout parseable", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-reports-"));
  const { stdout, stderr, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor", "--json"], {
    ...writer,
    reportRoot,
    runDoctor: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      checks: [{ code: "RUNTIME_PROBE_REQUIRED", result: "WARN" }],
      warnings: [{ code: "AUTH_REQUIRED", message: "Open a new session and complete sign-in." }],
      next_steps: ["Open a new session and complete sign-in."],
      exit_code: 2
    })
  });

  assert.equal(exitCode, 2);
  assert.equal(stderr.join(""), "");

  const result = jsonResult(stdout);
  assert.equal(result.status, "WARN");
  assert.match(result.report_url, /^file:\/\//u);
  assert.equal(result.report_file.startsWith(reportRoot), true);

  const persisted = JSON.parse(await fsp.readFile(result.report_file, "utf8"));
  assert.deepEqual(persisted, result);

  if (process.platform !== "win32") {
    const reportDirMode = (await fsp.stat(reportRoot)).mode & 0o777;
    const reportFileMode = (await fsp.stat(result.report_file)).mode & 0o777;
    assert.equal(reportDirMode, 0o700);
    assert.equal(reportFileMode, 0o600);
  }
});

test("human mode prints friendly summary and non-tty progress without raw JSON", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-human-reports-"));
  const { stdout, stderr, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor"], {
    ...writer,
    reportRoot,
    stdoutStream: { isTTY: false },
    stderrStream: { isTTY: false },
    runDoctor: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      checks: [{ code: "AUTH_REQUIRED", result: "WARN" }],
      warnings: [{ code: "AUTH_REQUIRED", message: "Open a new session and complete native OAuth." }],
      next_steps: ["Open a new session and complete native OAuth."],
      exit_code: 2
    })
  });

  assert.equal(exitCode, 2);
  assert.match(stderr.join(""), /Running BIOS Implant doctor/u);
  const rendered = stdout.join("");
  assert.match(rendered, /^BIOS Implant Doctor /u);
  assert.match(rendered, /Overall\s+! WARN\s+Doctor found required next steps; installation readiness is not yet proven\./u);
  assert.match(
    rendered,
    /Next actions\n\n1\. AUTHORIZE THE REMOTE MCP\n   Open a new session in the intended harness\.\n   Complete native OAuth only if the harness prompts for it\./u
  );
  assert.match(rendered, /Report: file:\/\//u);
  assert.ok(!rendered.includes('"status"'));
  assert.doesNotMatch(rendered, ANSI_PATTERN);
});

test("human doctor renders the exact Codex OAuth command as an action", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-codex-auth-report-"));
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor"], {
    ...writer,
    reportRoot,
    stdoutStream: { isTTY: false },
    stderrStream: { isTTY: false },
    runDoctor: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      checks: [{ code: "AUTH_REQUIRED", result: "WARN" }],
      warnings: [{ code: "AUTH_REQUIRED", message: "Codex OAuth is required." }],
      next_steps: ["Complete native OAuth discovery: codex mcp login implant"],
      exit_code: 2
    })
  });

  assert.equal(exitCode, 2);
  assert.match(
    stdout.join(""),
    /1\. AUTHORIZE CODEX\n   Run:\n     codex mcp login implant\n   Approve the browser consent flow opened by Codex\.\n   Expected: Codex reports a successful MCP login; then rerun doctor\./u
  );
});

test("human doctor renders a colored status table on TTY stdout", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-human-doctor-table-"));
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor"], {
    ...writer,
    reportRoot,
    stdoutStream: { isTTY: true },
    env: {},
    runDoctor: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      requested_harnesses: ["auto"],
      detected_harnesses: [
        {
          harness: "claude",
          detected: true,
          supported: true,
          executable: "/Users/tester/.local/bin/claude",
          version: "2.0.0",
          required_version: "1.0.0"
        },
        {
          harness: "codex",
          detected: true,
          supported: true,
          executable: "/Users/tester/.codex/bin/codex",
          version: "0.146.0",
          required_version: "0.146.0"
        }
      ],
      checks: [
        {
          harness: "claude",
          code: "CLAUDE_PLUGIN_PRESENT",
          result: "PASS",
          evidence: {
            executable: "/Users/tester/.local/bin/claude",
            version: "2.0.0",
            plugin_version: PACKAGE_VERSION,
            scope: "user",
            enabled: true,
            mcp_servers: ["implant", "implant-local"]
          }
        },
        {
          harness: "codex",
          code: "CODEX_PLUGIN_PRESENT",
          result: "PASS",
          evidence: {
            executable: "/Users/tester/.codex/bin/codex",
            version: "0.146.0",
            marketplace_name: "agent-university",
            source: { source: "npm", package: "@agentuniversity/bios-implant" }
          }
        },
        {
          harness: "codex",
          code: "WARNING_RUNTIME_PROBE_REQUIRED",
          result: "WARN",
          evidence: {
            url: "https://implant.agents.university/mcp",
            oauth_client_id: "bios-implant",
            next_action: "Run the in-harness doctor skill or native login flow to confirm the exact OAuth scope set."
          }
        }
      ],
      warnings: [{ code: "RUNTIME_PROBE_REQUIRED", message: "Open a new session and run the doctor skill to complete the authenticated probe." }],
      next_steps: ["Open a new session and run the doctor skill."],
      exit_code: 2
    })
  });

  assert.equal(exitCode, 2);
  const rendered = stdout.join("");
  assert.match(rendered, /^\u001B\[[0-9;]*m/u);
  assert.match(stripAnsi(rendered), /^BIOS Implant Doctor /u);
  assert.match(rendered, /Overall\s+\u001B\[33m! WARN\u001B\[0m/u);
  assert.match(rendered, /\u001B\[32m✓ DETECTED\u001B\[0m/u);
  assert.match(rendered, /\u001B\[33m! WARN\u001B\[0m/u);
  assert.match(rendered, /Harness\s+Detected\s+Registration\s+Health/u);
  assert.match(stripAnsi(rendered), /Claude Code\s+✓ DETECTED\s+✓ READY\s+✓ PASS/u);
  assert.match(stripAnsi(rendered), /Codex\s+✓ DETECTED\s+✓ READY\s+! WARN/u);
  assert.match(stripAnsi(rendered), /Issues\n- Codex: Run the in-harness doctor skill or native login flow to confirm the exact OAuth scope set\./u);
  assert.match(
    stripAnsi(rendered),
    /Next actions\n\n1\. RESTART THE HARNESS\n   Open a new Claude Desktop \/ Local Cowork, Claude Code, or Codex session\.\n   Run the installed doctor skill in that new session\./u
  );
  assert.match(rendered, /Report: file:\/\//u);
  assert.ok(!rendered.includes('"checks"'));
});

test("human doctor uses resolved Local Cowork metadata for explicit cowork selection", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-human-cowork-doctor-"));
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor"], {
    ...writer,
    reportRoot,
    stdoutStream: { isTTY: false },
    runDoctor: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      requested_harnesses: ["cowork"],
      detected_harnesses: [
        {
          harness: "claude",
          detected: true,
          supported: true,
          executable: "/Users/tester/.local/bin/claude",
          version: "2.0.0",
          required_version: "1.0.0"
        }
      ],
      detected_harnesses_by_name: {
        cowork: {
          harness: "cowork",
          detected: true,
          supported: true,
          executable: "/Users/tester/.local/bin/claude",
          version: "2.0.0",
          required_version: "1.0.0",
          app_present: true
        }
      },
      checks: [
        {
          harness: "cowork",
          code: "CLAUDE_PLUGIN_PRESENT",
          result: "PASS",
          evidence: {
            executable: "/Users/tester/.local/bin/claude",
            version: "2.0.0",
            plugin_version: PACKAGE_VERSION,
            scope: "user"
          }
        },
        {
          harness: "cowork",
          code: "WARNING_RUNTIME_PROBE_REQUIRED",
          result: "WARN",
          evidence: {
            next_action: "Run the in-harness doctor skill from Local Cowork to confirm runtime health."
          }
        }
      ],
      warnings: [{ code: "RUNTIME_PROBE_REQUIRED", message: "Open a new session and run the doctor skill to complete the authenticated probe." }],
      next_steps: ["Open a new session and run the doctor skill."],
      exit_code: 2
    })
  });

  assert.equal(exitCode, 2);
  const rendered = stripAnsi(stdout.join(""));
  assert.match(rendered, /Local Cowork\s+✓ DETECTED\s+✓ READY\s+! WARN/u);
  assert.doesNotMatch(rendered, /^Claude Code\s/mu);
  assert.ok(!rendered.includes("Not detected on this host."));
});

test("human doctor suppresses ANSI on TTY when NO_COLOR is set", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-human-no-color-"));
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor"], {
    ...writer,
    reportRoot,
    stdoutStream: { isTTY: true },
    env: { NO_COLOR: "1" },
    runDoctor: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      requested_harnesses: ["claude"],
      detected_harnesses: [{
        harness: "claude",
        detected: true,
        supported: true,
        executable: "/Users/tester/.local/bin/claude",
        version: "2.0.0"
      }],
      checks: [{
        harness: "claude",
        code: "AUTH_REQUIRED",
        result: "WARN",
        evidence: { next_action: "Open a new session and run the doctor skill." }
      }],
      warnings: [{ code: "AUTH_REQUIRED", message: "Open a new session and complete native OAuth." }],
      next_steps: ["Open a new session and run the doctor skill."],
      exit_code: 2
    })
  });

  assert.equal(exitCode, 2);
  const rendered = stdout.join("");
  assert.match(rendered, /^BIOS Implant Doctor /u);
  assert.doesNotMatch(rendered, ANSI_PATTERN);
});

test("human doctor repairs missing registration before session guidance", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-human-registration-repair-"));
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor"], {
    ...writer,
    reportRoot,
    stdoutStream: { isTTY: true },
    env: {},
    runDoctor: async () => ({
      status: "FAIL",
      version: PACKAGE_VERSION,
      requested_harnesses: ["auto"],
      detected_harnesses: [
        {
          harness: "claude",
          detected: true,
          supported: true,
          executable: "/Users/tester/.local/bin/claude",
          version: "2.0.0"
        },
        {
          harness: "codex",
          detected: true,
          supported: true,
          executable: "/Users/tester/.codex/bin/codex",
          version: "0.146.0"
        }
      ],
      checks: [
        {
          harness: "claude",
          code: "CLAUDE_PLUGIN_MISSING",
          result: "FAIL",
          evidence: {
            next_action: "Open a new session and run the doctor skill."
          }
        },
        {
          harness: "codex",
          code: "CODEX_MCP_MISSING",
          result: "FAIL",
          evidence: {
            next_action: "Open a new Codex session and run the doctor skill."
          }
        }
      ],
      warnings: [{ code: "AUTH_REQUIRED", message: "Open a new session and complete native OAuth." }],
      next_steps: [
        "Open a new session and run the doctor skill.",
        "Obtain the owner-provided one-use setup URL. Give it only to the connect skill from the intended workspace; never give it to the installer or doctor."
      ],
      exit_code: 1
    })
  });

  assert.equal(exitCode, 1);
  const colored = stdout.join("");
  const rendered = stripAnsi(colored);
  assert.match(rendered, /Claude Code\s+✓ DETECTED\s+✗ MISSING\s+✗ FAIL/u);
  assert.match(rendered, /Codex\s+✓ DETECTED\s+✗ MISSING\s+✗ FAIL/u);
  assert.match(
    rendered,
    /Next actions\n\n1\. REPAIR REGISTRATION\n   Run:\n     npx -y @agentuniversity\/bios-implant@latest install --yes --harness all/u
  );
  assert.match(rendered, /Expected: Every selected harness shows Registration as READY\./u);
  assert.match(
    rendered,
    /2\. VERIFY HOST SETUP\n   Run:\n     npx -y @agentuniversity\/bios-implant@latest doctor/u
  );
  assert.match(rendered, /3\. RESTART THE HARNESS/u);
  assert.match(rendered, /4\. CONNECT THE WORKSPACE/u);
  assert.match(rendered, /SECURITY: Never give the one-use setup URL to install or doctor\./u);
  assert.match(colored, /\u001B\[1m\u001B\[36m1\. REPAIR REGISTRATION\u001B\[0m/u);
  assert.match(
    colored,
    /\u001B\[33mnpx -y @agentuniversity\/bios-implant@latest install --yes --harness all\u001B\[0m/u
  );
  assert.match(colored, /\u001B\[1m\u001B\[31mSECURITY:\u001B\[0m/u);
});

test("doctor returns warn exit 3 when only unsupported detected harnesses are present", async () => {
  const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture();
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor", "--json"], {
    ...writer,
    packageRoot,
    homeDirectory,
    env: { HOME: homeDirectory, BIOS_IMPLANT_STATE_ROOT: stateRoot },
    detectHarnessesImpl: async () => ({
      detections: [
        {
          harness: "codex",
          detected: true,
          supported: false,
          executable: "/usr/local/bin/codex",
          version: "0.145.0",
          required_version: "0.146.0"
        }
      ],
      byHarness: {
        codex: {
          harness: "codex",
          detected: true,
          supported: false,
          executable: "/usr/local/bin/codex",
          version: "0.145.0",
          required_version: "0.146.0"
        }
      }
    }),
    doctorHarnessImpl: async () => {
      throw new Error("doctorHarness should not run when no supported harnesses are selected");
    },
    localCompanionProbe: async () => healthyLocalCompanionProbe(),
    fetchImplant: async () => ({
      status: 401,
      url: "https://implant.agents.university/mcp",
      redirected: false,
      text: async () => JSON.stringify({ error: "unauthorized" })
    })
  });

  assert.equal(exitCode, 3);
  const result = jsonResult(stdout);
  assert.equal(result.status, "WARN");
  assert.deepEqual(result.requested_harnesses, ["auto"]);
});

test("human dry run clearly says that no changes were applied", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-dry-run-reports-"));
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["install", "--dry-run"], {
    ...writer,
    reportRoot,
    stderrStream: { isTTY: false },
    runInstaller: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      dry_run: true,
      harnesses: [],
      warnings: [{ code: "AUTH_REQUIRED", message: "Sign-in would still be required." }],
      next_steps: ["This next step must be replaced in human dry-run mode."],
      exit_code: 0
    })
  });

  assert.equal(exitCode, 0);
  const rendered = stdout.join("");
  assert.match(rendered, /dry run completed\. No changes were applied\./u);
  assert.match(rendered, /without --dry-run/u);
  assert.ok(!rendered.includes("was installed"));
  assert.ok(!rendered.includes("This next step must be replaced"));
});

test("human install report confirms native Cowork registration while profile details stay private", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-human-install-reports-"));
  const { stdout, stderr, writer } = createOutputBuffers();
  const profilePath = "/Users/tester/Library/Application Support/Claude/local-agent-mode-sessions/account/org";

  const exitCode = await runCli(["install", "--yes"], {
    ...writer,
    reportRoot,
    stderrStream: { isTTY: false },
    runInstaller: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      harnesses: [{
        harness: "cowork",
        result: "WARN",
        code: "OK",
        details: {
          registration_state: "installed_and_verified",
          cowork_profile: { config_dir: profilePath }
        },
        warnings: [{
          code: "RUNTIME_PROBE_REQUIRED",
          message: "Verify the authenticated runtime in a fresh Local Cowork session."
        }],
        next_steps: [
          "Open a new Local Cowork session and run the BIOS Implant doctor skill."
        ]
      }],
      warnings: [{
        code: "BINDING_REQUIRED",
        message: "Run the connect flow in the intended workspace."
      }],
      next_steps: [
        "Open a new Local Cowork session and run the BIOS Implant doctor skill."
      ],
      exit_code: 0
    })
  });

  assert.equal(exitCode, 0);
  assert.match(stderr.join(""), /Running BIOS Implant install/u);

  const rendered = stdout.join("");
  assert.match(rendered, /^━+/u);
  assert.match(rendered, /🧠 BIOS Implant/u);
  assert.match(rendered, /✅ INSTALLATION COMPLETE/u);
  assert.match(rendered, /⚠️  WORKSPACE SETUP STILL REQUIRED/u);
  assert.match(rendered, /📦 INSTALLATION STATUS/u);
  assert.match(rendered, /Local Cowork\s+✓ INSTALLED\s+Restart \+ doctor/u);
  assert.match(rendered, /1\. 🔄 OPEN A NEW SESSION/u);
  assert.match(rendered, /📄 TECHNICAL REPORT/u);
  assert.match(rendered, /Open: file:\/\//u);
  assert.ok(!rendered.includes(profilePath));
  assert.ok(!rendered.includes("attached"));

  const reportPath = rendered.match(/Path: (.+)\n/u)?.[1];
  assert.ok(reportPath);
  const persisted = JSON.parse(await fsp.readFile(reportPath, "utf8"));
  assert.equal(persisted.harnesses[0].details.registration_state, "installed_and_verified");
  assert.equal(persisted.harnesses[0].details.cowork_profile.config_dir, profilePath);
});

test("human install renders a colored, actionable all-harness summary on TTY", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-install-visual-report-"));
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["install", "--yes", "--harness", "all"], {
    ...writer,
    reportRoot,
    stdoutStream: { isTTY: true },
    stderrStream: { isTTY: false },
    env: {},
    runInstaller: async () => ({
      status: "WARN",
      version: PACKAGE_VERSION,
      requested_harnesses: ["claude", "codex"],
      harnesses: [
        {
          harness: "claude",
          result: "WARN",
          code: "OK",
          warnings: [{ code: "RUNTIME_PROBE_REQUIRED" }],
          next_steps: ["Open a new Claude Local Cowork or Claude Code session and run the doctor skill."]
        },
        {
          harness: "codex",
          result: "WARN",
          code: "OK",
          warnings: [{ code: "AUTH_REQUIRED" }],
          next_steps: ["Complete native OAuth discovery: codex mcp login implant"]
        }
      ],
      warnings: [
        { code: "BINDING_REQUIRED" },
        { code: "AUTH_REQUIRED" },
        { code: "RUNTIME_PROBE_REQUIRED" }
      ],
      next_steps: ["Finish BIOS Implant setup in the intended workspace."],
      exit_code: 0
    })
  });

  assert.equal(exitCode, 0);
  const rendered = stdout.join("");
  const plain = stripAnsi(rendered);
  assert.match(rendered, /\u001B\[32m✅ INSTALLATION COMPLETE\u001B\[0m/u);
  assert.match(rendered, /\u001B\[33m⚠️  WORKSPACE SETUP STILL REQUIRED\u001B\[0m/u);
  assert.match(plain, /📦 INSTALLATION STATUS/u);
  assert.match(plain, /Claude Code\s+✓ INSTALLED\s+Restart \+ doctor/u);
  assert.match(plain, /Codex\s+✓ INSTALLED\s+Verify OAuth/u);
  assert.match(plain, /1\. 🔄 OPEN A NEW SESSION/u);
  assert.match(plain, /2\. 🩺 RUN THE DOCTOR SKILL/u);
  assert.match(plain, /3\. 🔐 AUTHORIZE CODEX IF PROMPTED/u);
  assert.match(plain, /codex mcp login implant/u);
  assert.match(plain, /4\. 🔗 CONNECT THIS WORKSPACE/u);
  assert.match(plain, /📄 TECHNICAL REPORT/u);
  assert.ok(!plain.includes('"harnesses"'));
});

test("human failure writes technical details to an error report instead of dumping them", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-human-failure-reports-"));
  const { stdout, stderr, writer } = createOutputBuffers();
  const technicalMessage = "Failed to parse /Users/tester/.agent-university/private/marketplace.json: internal schema trace";

  const exitCode = await runCli(["install", "--yes"], {
    ...writer,
    reportRoot,
    stderrStream: { isTTY: false },
    runInstaller: async () => ({
      status: "FAIL",
      version: PACKAGE_VERSION,
      harnesses: [{
        harness: "cowork",
        result: "FAIL",
        code: "COMMAND_FAILED",
        message: technicalMessage,
        warnings: [],
        next_steps: []
      }],
      warnings: [],
      next_steps: ["Retry once after reviewing the saved error report."],
      exit_code: 1
    })
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.join(""), /Running BIOS Implant install/u);
  const rendered = stdout.join("");
  assert.match(rendered, /❌ INSTALLATION FAILED/u);
  assert.match(rendered, /📄 ERROR REPORT/u);
  assert.match(rendered, /Open: file:\/\//u);
  assert.match(rendered, /Retry once after reviewing the saved error report\./u);
  assert.ok(!rendered.includes(technicalMessage));
  assert.ok(!rendered.includes("/Users/tester"));

  const reportPath = rendered.match(/Path: (.+)\n/u)?.[1];
  assert.ok(reportPath);
  const persisted = JSON.parse(await fsp.readFile(reportPath, "utf8"));
  assert.equal(persisted.harnesses[0].message, technicalMessage);
  assert.equal(persisted.status, "FAIL");
});

test("interactive TTY mode shows spinner frames only on stderr and still ends with concise stdout", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-spinner-reports-"));
  const { stdout, stderr, writer } = createOutputBuffers();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  const runPromise = runCli(["doctor"], {
    ...writer,
    reportRoot,
    stderrStream: { isTTY: true },
    runDoctor: async () => {
      await pending;
      return {
        status: "PASS",
        version: PACKAGE_VERSION,
        checks: [],
        warnings: [],
        next_steps: [],
        exit_code: 0
      };
    }
  });

  await waitFor(() => stderr.length > 0);
  release();
  const exitCode = await runPromise;

  assert.equal(exitCode, 0);
  assert.ok(stderr.some((chunk) => /\| Running BIOS Implant doctor\.\.\.\r/u.test(chunk)));
  assert.match(stdout.join(""), /^BIOS Implant Doctor /u);
  assert.match(stdout.join(""), /Overall\s+✓ PASS/u);
});

test("usage and internal failures persist structured error reports without masking the original outcome", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-error-reports-"));

  const usageOutput = createOutputBuffers();
  const usageExit = await runCli(["install"], {
    ...usageOutput.writer,
    reportRoot
  });
  assert.equal(usageExit, 64);
  assert.match(usageOutput.stderr.join(""), /Use --yes to run install noninteractively/u);

  const usageFiles = await fsp.readdir(reportRoot);
  assert.equal(usageFiles.length >= 1, true);
  const usageReportPath = path.join(reportRoot, usageFiles.sort().at(-1));
  const usageReport = JSON.parse(await fsp.readFile(usageReportPath, "utf8"));
  assert.equal(usageReport.code, "USAGE_ERROR");
  assert.equal(usageReport.exit_code, 64);
  assert.match(usageReport.report_url, /^file:\/\//u);

  const brokenReportRoot = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-report-root-")), "occupied");
  await fsp.writeFile(brokenReportRoot, "nope", "utf8");
  const internalOutput = createOutputBuffers();
  const internalExit = await runCli(["doctor"], {
    ...internalOutput.writer,
    reportRoot: brokenReportRoot,
    runDoctor: async () => {
      throw new Error("boom");
    }
  });

  assert.equal(internalExit, 70);
  const internalRendered = internalOutput.stderr.join("");
  assert.match(internalRendered, /Overall\s+✗ FAIL\s+boom/u);
  assert.match(internalRendered, /Diagnostics could not be saved/u);
});

test("json cancellation persists report metadata and does not emit progress noise", async () => {
  const reportRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-implant-cancel-reports-"));
  const { stdout, stderr, writer } = createOutputBuffers();

  const exitCode = await runCli(["uninstall", "--json"], {
    ...writer,
    reportRoot,
    stderrStream: { isTTY: true },
    confirmMutation: async () => false
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  const result = jsonResult(stdout);
  assert.equal(result.code, "USER_CANCELLED");
  assert.match(result.report_url, /^file:\/\//u);
  assert.ok(result.report_file.startsWith(reportRoot));
});

test("doctor uses AGENT_UNIVERSITY_HOME when BIOS_IMPLANT_STATE_ROOT is absent and exits 3 with no harnesses", async () => {
  const { packageRoot, homeDirectory, stateRoot } = await createDoctorFixture();
  const { stdout, writer } = createOutputBuffers();

  const exitCode = await runCli(["doctor", "--json"], {
    ...writer,
    packageRoot,
    homeDirectory,
    env: { HOME: homeDirectory, AGENT_UNIVERSITY_HOME: stateRoot },
    detectHarnessesImpl: async () => ({ detections: [], byHarness: {} }),
    doctorHarnessImpl: async () => healthyHarnessDoctor(),
    localCompanionProbe: async () => healthyLocalCompanionProbe(),
    fetchImplant: async () => ({
      status: 401,
      url: "https://implant.agents.university/mcp",
      redirected: false,
      text: async () => JSON.stringify({ error: "unauthorized" })
    })
  });

  assert.equal(exitCode, 3);
  const result = jsonResult(stdout);
  assert.equal(result.status, "WARN");
  assert.ok(result.checks.some((check) => check.code === "PERSISTENT_MARKETPLACE_OWNER_VALID"));
  assert.ok(result.checks.some((check) => check.code === "PERSISTENT_MARKETPLACE_SOURCE_VALID"));
});
