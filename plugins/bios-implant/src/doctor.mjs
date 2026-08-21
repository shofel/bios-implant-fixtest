import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  REMOTE_MCP
} from "./constants.mjs";
import {
  EXIT_DOCTOR_PARTIAL,
  FAILURE_HARNESS_NOT_DETECTED as HARNESS_NOT_DETECTED,
  HARNESS_AUTO,
  RESULT_FAIL,
  RESULT_PASS,
  RESULT_SKIP,
  RESULT_WARN,
  WARNING_AUTH_REQUIRED,
  WARNING_BINDING_REQUIRED,
  WARNING_REMOTE_UNREACHABLE,
  detectHarnesses,
  doctorHarness,
  resolveHarnesses,
  selectRequestedHarnesses
} from "./harnesses.mjs";
import { packageRootFrom, readJsonIfExists, runCommand } from "./util.mjs";

const CHECK_PASS = RESULT_PASS;
const CHECK_WARN = RESULT_WARN;
const CHECK_FAIL = RESULT_FAIL;
const CHECK_SKIP = RESULT_SKIP;
const REMOTE_REACHABLE = "REMOTE_REACHABLE";
const REMOTE_CONTRACT_INVALID = "REMOTE_CONTRACT_INVALID";
const RUNTIME_PROBE_REQUIRED = "RUNTIME_PROBE_REQUIRED";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PROBE_BYTES = 4096;
const ERROR_REMOTE_CONTRACT_INVALID = "REMOTE_CONTRACT_INVALID";
const BINDING_REQUIRED_NEXT_STEP = [
  "Obtain the owner-provided one-use setup URL.",
  "Give it only to the connect skill from the intended workspace; never give it to the installer or doctor."
].join(" ");
const EXPECTED_LOCAL_TOOLS = Object.freeze([
  "local_activate",
  "local_connect",
  "local_doctor",
  "local_selection",
  "local_stage",
  "local_hello",
  "local_status"
]);
const EXPECTED_MARKETPLACE_SOURCE = Object.freeze({
  source: "npm",
  package: PACKAGE_NAME
});
const EXPECTED_MARKETPLACE_OWNER_NAME = "Agent University";

function packageRootFor(deps) {
  return deps.packageRoot ?? packageRootFrom(import.meta.url);
}

function homeDirectoryFrom(options, deps) {
  return options.homeDirectory ?? deps.homeDirectory ?? deps.env?.HOME ?? os.homedir();
}

function stateRootFrom(options, deps) {
  if (options.stateRoot) {
    return path.resolve(options.stateRoot);
  }

  if (deps.stateRoot) {
    return path.resolve(deps.stateRoot);
  }

  const env = deps.env ?? process.env;
  return path.resolve(
    env.BIOS_IMPLANT_STATE_ROOT
      ?? env.AGENT_UNIVERSITY_HOME
      ?? path.join(homeDirectoryFrom(options, deps), ".agent-university")
  );
}

function installHomeFrom(stateRoot) {
  return path.join(stateRoot, "bios-implant");
}

function catalogHomeFrom(stateRoot) {
  return path.join(installHomeFrom(stateRoot), "catalog");
}

function replaceKnownRoot(value, root, replacement) {
  const normalized = String(root ?? "").replace(/[\\/]+$/u, "");
  if (!normalized) {
    return value;
  }

  let redacted = "";
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(normalized, offset);
    if (index === -1) {
      redacted += value.slice(offset);
      break;
    }

    const before = index > 0 ? value[index - 1] : "";
    const afterIndex = index + normalized.length;
    const after = afterIndex < value.length ? value[afterIndex] : "";
    const startsAtBoundary = index === 0 || /[\s"'`([{=,:]/u.test(before);
    const endsAtBoundary = afterIndex === value.length || /[\\/\s"'`<>|:;,\)\]}]/u.test(after);

    if (startsAtBoundary && endsAtBoundary) {
      redacted += `${value.slice(offset, index)}${replacement}`;
      offset = afterIndex;
      continue;
    }

    redacted += value.slice(offset, index + 1);
    offset = index + 1;
  }

  return redacted;
}

function redactGenericAbsolutePaths(value) {
  const redactMatch = (_match, boundary) => `${boundary}<absolute>`;
  return value
    .replace(/(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^"'`\r\n]+)\1/gu, "$1<absolute>$1")
    .replace(/(^|[\s"'`([{=,:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|:;,\)\]}]*/gu, redactMatch)
    .replace(/(^|[\s"'`([{=,:])\/(?!\/)[^\s"'`<>|:;,\)\]}]+/gu, redactMatch);
}

function redactPath(value, homeDirectory, stateRoot) {
  if (typeof value !== "string") {
    return value;
  }

  const replacements = [];
  if (stateRoot && stateRoot !== homeDirectory) {
    replacements.push({ from: stateRoot, to: "<stateRoot>" });
  }
  if (homeDirectory) {
    replacements.push({ from: homeDirectory, to: "~" });
  }

  let redacted = value;
  for (const { from, to } of replacements.sort((left, right) => right.from.length - left.from.length)) {
    redacted = replaceKnownRoot(redacted, from, to);
  }

  return redactGenericAbsolutePaths(redacted);
}

function sanitizeValue(value, homeDirectory, stateRoot, verbose) {
  if (verbose) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, homeDirectory, stateRoot, verbose));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, homeDirectory, stateRoot, verbose)])
    );
  }

  return redactPath(value, homeDirectory, stateRoot);
}

async function pathCheck(targetPath, code, deps) {
  const fileSystem = deps.fs ?? fsp;
  try {
    await fileSystem.access(targetPath);
    return { code, result: CHECK_PASS, evidence: { path: targetPath } };
  } catch {
    return { code, result: CHECK_FAIL, evidence: { path: targetPath } };
  }
}

function parseNodeVersion(version) {
  const raw = String(version ?? process.versions.node);
  const major = Number.parseInt(raw.split(".")[0], 10);
  return { raw, major };
}

async function readJsonFile(filePath, deps) {
  const fileSystem = deps.fs ?? fsp;
  return JSON.parse(await fileSystem.readFile(filePath, "utf8"));
}

async function readJsonFileSafe(filePath, deps) {
  try {
    return { value: await readJsonFile(filePath, deps), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function versionCheck(code, version, filePath) {
  return {
    code,
    result: version === PACKAGE_VERSION ? CHECK_PASS : CHECK_FAIL,
    evidence: {
      path: filePath,
      expected_version: PACKAGE_VERSION,
      observed_version: version ?? null
    }
  };
}

function validateMarketplaceJson(code, marketplace, filePath) {
  const pluginEntry = marketplace?.plugins?.find((entry) => entry?.name === "bios-implant");
  const source = pluginEntry?.source;
  const matches =
    source?.source === EXPECTED_MARKETPLACE_SOURCE.source &&
    source?.package === EXPECTED_MARKETPLACE_SOURCE.package;

  return {
    code,
    result: matches ? CHECK_PASS : CHECK_FAIL,
    evidence: {
      path: filePath,
      expected_source: EXPECTED_MARKETPLACE_SOURCE,
      observed_source: source ?? null
    }
  };
}

function validateMarketplaceOwner(code, marketplace, filePath) {
  const ownerName = marketplace?.owner?.name;
  return {
    code,
    result: typeof ownerName === "string" && ownerName.trim() === EXPECTED_MARKETPLACE_OWNER_NAME
      ? CHECK_PASS
      : CHECK_FAIL,
    evidence: {
      path: filePath,
      expected_owner: { name: EXPECTED_MARKETPLACE_OWNER_NAME },
      observed_owner: marketplace?.owner ?? null
    }
  };
}

function validateDistributionMarketplace(code, marketplace, filePath) {
  const pluginEntry = marketplace?.plugins?.find((entry) => entry?.name === "bios-implant");
  const valid =
    marketplace?.name === "agent-university" &&
    marketplace?.owner?.name === EXPECTED_MARKETPLACE_OWNER_NAME &&
    pluginEntry?.source === "./";
  return {
    code,
    result: valid ? CHECK_PASS : CHECK_FAIL,
    evidence: {
      path: filePath,
      observed_marketplace_name: marketplace?.name ?? null,
      observed_owner: marketplace?.owner ?? null,
      observed_source: pluginEntry?.source ?? null
    }
  };
}

function validateClaudeManifest(manifest, filePath) {
  const valid =
    manifest?.version === PACKAGE_VERSION &&
    manifest?.skills === "./skills/" &&
    manifest?.hooks === "./hooks/claude.json" &&
    typeof manifest?.mcpServers === "object" &&
    manifest?.mcpServers !== null;

  return {
    code: "CLAUDE_MANIFEST_VALID",
    result: valid ? CHECK_PASS : CHECK_FAIL,
    evidence: {
      path: filePath,
      expected_version: PACKAGE_VERSION,
      observed: {
        version: manifest?.version ?? null,
        skills: manifest?.skills ?? null,
        hooks: manifest?.hooks ?? null,
        mcpServers: manifest?.mcpServers ?? null
      }
    }
  };
}

function validateCodexManifest(manifest, filePath) {
  const valid =
    manifest?.version === PACKAGE_VERSION &&
    manifest?.skills === "./skills/" &&
    manifest?.mcpServers === "./.mcp.json";

  return {
    code: "CODEX_MANIFEST_VALID",
    result: valid ? CHECK_PASS : CHECK_FAIL,
    evidence: {
      path: filePath,
      expected_version: PACKAGE_VERSION,
      observed: {
        version: manifest?.version ?? null,
        skills: manifest?.skills ?? null,
        mcpServers: manifest?.mcpServers ?? null
      }
    }
  };
}

function validateClaudeMcp(config, filePath) {
  const implant = config?.mcpServers?.implant;
  const local = config?.mcpServers?.["implant-local"];
  const valid =
    implant?.type === "http" &&
    implant?.url === REMOTE_MCP.url &&
    implant?.oauth === undefined &&
    local?.type === "stdio" &&
    local?.command === "node" &&
    Array.isArray(local?.args) &&
    local.args.includes("${CLAUDE_PLUGIN_ROOT}/dist/local-mcp.mjs");

  return {
    code: "CLAUDE_MCP_CONFIG_VALID",
    result: valid ? CHECK_PASS : CHECK_FAIL,
    evidence: {
      path: filePath,
      observed: {
        implant_url: implant?.url ?? null,
        oauth_discovery: implant?.oauth === undefined ? "server-managed" : "embedded-client-settings",
        local_args: local?.args ?? null
      }
    }
  };
}

function validateCodexMcp(config, filePath) {
  const local = config?.mcpServers?.["implant-local"];
  const valid =
    local?.type === "stdio" &&
    local?.command === "node" &&
    local?.cwd === "${CODEX_PLUGIN_ROOT}" &&
    Array.isArray(local?.args) &&
    local.args.includes("dist/local-mcp.mjs");

  return {
    code: "CODEX_MCP_CONFIG_VALID",
    result: valid ? CHECK_PASS : CHECK_FAIL,
    evidence: {
      path: filePath,
      observed: {
        cwd: local?.cwd ?? null,
        args: local?.args ?? null
      }
    }
  };
}

async function inspectPackageInventory(packageRoot, deps) {
  const checks = [];
  const requiredPaths = [
    ["ROOT_CLAUDE_MANIFEST_PRESENT", path.join(packageRoot, ".claude-plugin", "plugin.json")],
    ["ROOT_MARKETPLACE_PRESENT", path.join(packageRoot, ".claude-plugin", "marketplace.json")],
    ["ROOT_CODEX_MANIFEST_PRESENT", path.join(packageRoot, ".codex-plugin", "plugin.json")],
    ["ROOT_CODEX_MCP_PRESENT", path.join(packageRoot, ".mcp.json")],
    ["LOCAL_MCP_DIST_PRESENT", path.join(packageRoot, "dist", "local-mcp.mjs")],
    ["SETUP_SKILL_PRESENT", path.join(packageRoot, "SETUP.md")],
    ["SKILL_INSTALL_PRESENT", path.join(packageRoot, "skills", "install", "SKILL.md")],
    ["SKILL_CONNECT_PRESENT", path.join(packageRoot, "skills", "connect", "SKILL.md")],
    ["SKILL_BOOT_PRESENT", path.join(packageRoot, "skills", "boot", "SKILL.md")],
    ["SKILL_DOCTOR_PRESENT", path.join(packageRoot, "skills", "doctor", "SKILL.md")],
    ["CLAUDE_HOOK_PRESENT", path.join(packageRoot, "hooks", "claude.json")],
    ["CODEX_HOOK_PRESENT", path.join(packageRoot, "hooks", "codex.json")],
    ["BOOT_PROTOCOL_PRESENT", path.join(packageRoot, "scripts", "boot-protocol.mjs")],
    ["BUNDLED_MARKETPLACE_PRESENT", path.join(packageRoot, "catalog", ".claude-plugin", "marketplace.json")]
  ];

  checks.push(...await Promise.all(requiredPaths.map(([code, filePath]) => pathCheck(filePath, code, deps))));

  const claudeManifestPath = path.join(packageRoot, ".claude-plugin", "plugin.json");
  const codexManifestPath = path.join(packageRoot, ".codex-plugin", "plugin.json");
  const codexMcpPath = path.join(packageRoot, ".mcp.json");
  const marketplacePath = path.join(packageRoot, "catalog", ".claude-plugin", "marketplace.json");
  const distributionMarketplacePath = path.join(packageRoot, ".claude-plugin", "marketplace.json");

  const jsonTargets = [
    ["CLAUDE_MANIFEST_JSON_VALID", claudeManifestPath, (value) => [
      versionCheck("CLAUDE_MANIFEST_VERSION", value.version, claudeManifestPath),
      validateClaudeManifest(value, claudeManifestPath),
      validateClaudeMcp(value, claudeManifestPath)
    ]],
    ["CODEX_MANIFEST_JSON_VALID", codexManifestPath, (value) => [
      versionCheck("CODEX_MANIFEST_VERSION", value.version, codexManifestPath),
      validateCodexManifest(value, codexManifestPath)
    ]],
    ["CODEX_MCP_JSON_VALID", codexMcpPath, (value) => [validateCodexMcp(value, codexMcpPath)]],
    ["ROOT_MARKETPLACE_JSON_VALID", distributionMarketplacePath, (value) => [
      validateDistributionMarketplace("ROOT_MARKETPLACE_CONTRACT_VALID", value, distributionMarketplacePath)
    ]],
    ["BUNDLED_MARKETPLACE_JSON_VALID", marketplacePath, (value) => [
      validateMarketplaceJson("BUNDLED_MARKETPLACE_SOURCE_VALID", value, marketplacePath),
      validateMarketplaceOwner("BUNDLED_MARKETPLACE_OWNER_VALID", value, marketplacePath)
    ]]
  ];

  for (const [code, filePath, buildChecks] of jsonTargets) {
    const parsed = await readJsonFileSafe(filePath, deps);
    checks.push({
      code,
      result: parsed.error ? CHECK_FAIL : CHECK_PASS,
      evidence: {
        path: filePath,
        message: parsed.error ? String(parsed.error.message ?? parsed.error) : null
      }
    });
    if (!parsed.error) {
      checks.push(...buildChecks(parsed.value));
    }
  }

  return checks;
}

async function inspectPersistentCatalog(stateRoot, deps) {
  const marketplacePath = path.join(catalogHomeFrom(stateRoot), ".claude-plugin", "marketplace.json");
  const checks = [await pathCheck(marketplacePath, "PERSISTENT_MARKETPLACE_PRESENT", deps)];
  const marketplacePresent = checks[0].result === CHECK_PASS;

  if (marketplacePresent) {
    const parsed = await readJsonFileSafe(marketplacePath, deps);
    checks.push({
      code: "PERSISTENT_MARKETPLACE_JSON_VALID",
      result: parsed.error ? CHECK_FAIL : CHECK_PASS,
      evidence: {
        path: marketplacePath,
        message: parsed.error ? String(parsed.error.message ?? parsed.error) : null
      }
    });
    if (!parsed.error) {
      checks.push(validateMarketplaceJson("PERSISTENT_MARKETPLACE_SOURCE_VALID", parsed.value, marketplacePath));
      checks.push(validateMarketplaceOwner("PERSISTENT_MARKETPLACE_OWNER_VALID", parsed.value, marketplacePath));
    }
  }

  return checks;
}

function parseJsonLines(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function probeLocalCompanion(packageRoot, options = {}, deps = {}) {
  if (typeof deps.localCompanionProbe === "function") {
    return deps.localCompanionProbe(packageRoot, options);
  }

  const launcher = path.join(packageRoot, "dist", "local-mcp.mjs");
  const input = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "bios-doctor", version: PACKAGE_VERSION }
      }
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  ].join("\n") + "\n";
  const command = deps.nodeExecutable ?? process.execPath;
  const execute = deps.runCommand ?? runCommand;

  try {
    const result = await execute(command, [launcher], {
      cwd: packageRoot,
      input,
      timeoutMs: timeoutMsFrom(options),
      maxOutputBytes: 64 * 1024
    });
    const messages = parseJsonLines(result.stdout);
    const initialize = messages.find((message) => message?.id === 1)?.result;
    const tools = messages.find((message) => message?.id === 2)?.result?.tools;
    const observedTools = Array.isArray(tools)
      ? tools.map((tool) => tool?.name).filter(Boolean).sort()
      : [];
    const valid =
      initialize?.serverInfo?.name === "implant-local" &&
      initialize?.serverInfo?.version === PACKAGE_VERSION &&
      initialize?.protocolVersion === "2024-11-05" &&
      observedTools.join("\n") === [...EXPECTED_LOCAL_TOOLS].sort().join("\n");

    return {
      code: "LOCAL_COMPANION_HANDSHAKE",
      result: valid ? CHECK_PASS : CHECK_FAIL,
      evidence: {
        server_name: initialize?.serverInfo?.name ?? null,
        server_version: initialize?.serverInfo?.version ?? null,
        protocol_version: initialize?.protocolVersion ?? null,
        tools: observedTools
      }
    };
  } catch (error) {
    return {
      code: "LOCAL_COMPANION_HANDSHAKE",
      result: CHECK_FAIL,
      evidence: {
        error_code: error?.code ?? "PROBE_FAILED"
      }
    };
  }
}

async function inspectLocalState(stateRoot, deps) {
  const checks = [];
  const installHome = installHomeFrom(stateRoot);
  const installStatePath = path.join(installHome, "install-state.json");
  const installState = await readJsonIfExists(installStatePath);
  checks.push({
    code: "INSTALL_STATE_PRESENT",
    result: installState ? CHECK_PASS : CHECK_WARN,
    evidence: {
      path: installStatePath
    }
  });

  const bindingRoot = path.join(stateRoot, "bios", "projects");
  let bindingCount = 0;
  try {
    const entries = await (deps.fs ?? fsp).readdir(bindingRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        await (deps.fs ?? fsp).access(path.join(bindingRoot, entry.name, "binding.json"));
        bindingCount += 1;
      } catch {
        // Ignore partial folders.
      }
    }
  } catch {
    bindingCount = 0;
  }

  checks.push({
    code: bindingCount > 0 ? "BINDING_PRESENT" : WARNING_BINDING_REQUIRED,
    result: bindingCount > 0 ? CHECK_PASS : CHECK_WARN,
    evidence: {
      binding_count: bindingCount,
      path: bindingRoot,
      ...(bindingCount > 0 ? {} : {
        next_action: BINDING_REQUIRED_NEXT_STEP
      })
    }
  });

  return { checks, installState };
}

function timeoutMsFrom(options) {
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.round(options.timeoutSeconds * 1000);
}

function classifyReachableStatus(status) {
  if (status === 401 || status === 403) {
    return "auth_required";
  }
  if (status >= 500) {
    return "unreachable";
  }
  if (status >= 400) {
    return "invalid";
  }
  if (status >= 300) {
    return "invalid";
  }
  return "reachable";
}

function canonicalRemoteUrl() {
  const remoteUrl = new URL(REMOTE_MCP.url);
  if (remoteUrl.protocol !== "https:") {
    const error = new Error("Remote probe URL must use HTTPS");
    error.code = ERROR_REMOTE_CONTRACT_INVALID;
    throw error;
  }
  return remoteUrl.href;
}

async function readProbeBody(response) {
  if (typeof response?.text !== "function") {
    const error = new Error("Remote probe response did not expose a text body");
    error.code = ERROR_REMOTE_CONTRACT_INVALID;
    throw error;
  }

  const body = await response.text();
  if (body.length > MAX_PROBE_BYTES) {
    const error = new Error("Remote probe response exceeded the maximum size");
    error.code = ERROR_REMOTE_CONTRACT_INVALID;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    const error = new Error("Remote probe returned a malformed success payload");
    error.code = ERROR_REMOTE_CONTRACT_INVALID;
    throw error;
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    const error = new Error("Remote probe returned an invalid success payload");
    error.code = ERROR_REMOTE_CONTRACT_INVALID;
    throw error;
  }

  return parsed;
}

async function defaultProbeFetch(url, timeoutMs, deps) {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Remote probe timed out")), timeoutMs);
  try {
    return await globalThis.fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function reachabilityCheck(options, deps) {
  const timeoutMs = timeoutMsFrom(options);
  const request = deps.fetchImplant ?? ((url) => defaultProbeFetch(url, timeoutMs, deps));

  try {
    const remoteUrl = canonicalRemoteUrl();
    const response = await request(remoteUrl, {
      timeoutMs,
      redirect: "manual"
    });
    const status = Number(response?.status ?? 0);
    const probeState = classifyReachableStatus(status);
    const finalUrl = response?.url ?? remoteUrl;

    if (response?.redirected || finalUrl !== remoteUrl || (status >= 300 && status < 400)) {
      return {
        code: REMOTE_CONTRACT_INVALID,
        result: CHECK_FAIL,
        evidence: {
          status,
          url: remoteUrl,
          final_url: finalUrl,
          probe_state: "invalid"
        }
      };
    }

    if (probeState === "auth_required") {
      return {
        code: WARNING_AUTH_REQUIRED,
        result: CHECK_WARN,
        evidence: {
          status,
          url: remoteUrl,
          final_url: finalUrl,
          probe_state: probeState
        }
      };
    }

    if (probeState === "unreachable") {
      return {
        code: WARNING_REMOTE_UNREACHABLE,
        result: CHECK_WARN,
        evidence: {
          status,
          url: remoteUrl,
          final_url: finalUrl,
          probe_state: probeState
        }
      };
    }

    if (probeState === "invalid") {
      return {
        code: REMOTE_CONTRACT_INVALID,
        result: CHECK_FAIL,
        evidence: {
          status,
          url: remoteUrl,
          final_url: finalUrl,
          probe_state: probeState
        }
      };
    }

    const payload = await readProbeBody(response);
    return {
      code: REMOTE_REACHABLE,
      result: CHECK_PASS,
      evidence: {
        status,
        url: remoteUrl,
        final_url: finalUrl,
        probe_state: probeState,
        response_shape: "json-object",
        payload_keys: Object.keys(payload).slice(0, 8)
      }
    };
  } catch (error) {
    if (error?.code === ERROR_REMOTE_CONTRACT_INVALID) {
      return {
        code: REMOTE_CONTRACT_INVALID,
        result: CHECK_FAIL,
        evidence: {
          message: error.message,
          url: REMOTE_MCP.url,
          probe_state: "invalid"
        }
      };
    }

    return {
      code: WARNING_REMOTE_UNREACHABLE,
      result: CHECK_WARN,
      evidence: {
        message: error instanceof Error ? error.message : String(error),
        url: REMOTE_MCP.url,
        probe_state: "unreachable"
      }
    };
  }
}

function summarizeStatus(checks, detectedHarnessCount) {
  const missingHarnessChecks = checks.filter((check) => check.code === HARNESS_NOT_DETECTED);
  const hasFailure = checks.some(
    (check) => check.result === CHECK_FAIL && check.code !== HARNESS_NOT_DETECTED
  );
  const hasWarning = checks.some((check) => check.result === CHECK_WARN);

  if (hasFailure) {
    return { status: RESULT_FAIL, exit_code: 1 };
  }

  if (missingHarnessChecks.length > 0) {
    return {
      status: missingHarnessChecks.some((check) => check.result === CHECK_FAIL) ? RESULT_FAIL : RESULT_WARN,
      exit_code: 3
    };
  }

  if (detectedHarnessCount === 0) {
    return { status: RESULT_WARN, exit_code: 3 };
  }

  if (hasWarning) {
    return { status: RESULT_WARN, exit_code: EXIT_DOCTOR_PARTIAL };
  }

  return { status: RESULT_PASS, exit_code: 0 };
}

export async function runDoctor(options = {}, deps = {}) {
  const packageRoot = packageRootFor(deps);
  const homeDirectory = homeDirectoryFrom(options, deps);
  const stateRoot = stateRootFrom(options, deps);
  const resolveHarnessesImpl = deps.resolveHarnessesImpl ?? resolveHarnesses;
  const detectHarnessesImpl = deps.detectHarnessesImpl ?? detectHarnesses;
  const selectRequestedHarnessesImpl = deps.selectRequestedHarnessesImpl ?? selectRequestedHarnesses;
  const doctorHarnessImpl = deps.doctorHarnessImpl ?? doctorHarness;
  const requestedHarnesses = resolveHarnessesImpl(options.harnesses ?? []);
  const detectionResult = await detectHarnessesImpl({ homeDirectory }, deps);
  const detectedHarnessEntries = Object.values(detectionResult.byHarness ?? {});
  const defaultDoctorSelection = requestedHarnesses.length === 1 && requestedHarnesses[0] === HARNESS_AUTO
    ? detectedHarnessEntries
      .filter((detection) => detection.detected && detection.supported)
      .map((detection) => detection.harness)
      .filter((harness, index, allHarnesses) => allHarnesses.indexOf(harness) === index)
    : null;
  const selectedHarnesses = defaultDoctorSelection ?? selectRequestedHarnessesImpl(requestedHarnesses, detectionResult);
  const autoSelected = requestedHarnesses.length === 1 && requestedHarnesses[0] === HARNESS_AUTO;
  const selectedSupportedHarnessCount = selectedHarnesses.filter(
    (harness) => detectionResult.byHarness?.[harness]?.detected && detectionResult.byHarness?.[harness]?.supported
  ).length;

  const checks = [];
  const warnings = [];
  const nextSteps = [];
  const verbose = options.verbose === true;

  const nodeVersion = parseNodeVersion(deps.nodeVersion ?? process.versions.node);
  checks.push({
    code: "NODE_VERSION",
    result: nodeVersion.major >= 20 ? CHECK_PASS : CHECK_FAIL,
    evidence: {
      version: nodeVersion.raw,
      minimum: "20.0.0"
    }
  });

  checks.push(...await inspectPackageInventory(packageRoot, deps));
  checks.push(...await inspectPersistentCatalog(stateRoot, deps));
  checks.push(await probeLocalCompanion(packageRoot, options, deps));

  const localStateInspection = await inspectLocalState(stateRoot, deps);
  checks.push(...localStateInspection.checks);

  for (const harness of selectedHarnesses) {
    const harnessDoctor = await doctorHarnessImpl(
      {
        harness,
        detection: detectionResult.byHarness[harness]
      },
      deps
    );
    let missingHarnessCheckPresent = false;
    for (const check of harnessDoctor.checks ?? []) {
      const harnessMissing = check.code === HARNESS_NOT_DETECTED;
      missingHarnessCheckPresent ||= harnessMissing;
      checks.push({
        ...check,
        ...(harnessMissing ? { result: autoSelected ? CHECK_WARN : CHECK_FAIL } : {}),
        harness
      });
    }

    if (harnessDoctor.code === HARNESS_NOT_DETECTED && !missingHarnessCheckPresent) {
      checks.push({
        code: HARNESS_NOT_DETECTED,
        result: autoSelected ? CHECK_WARN : CHECK_FAIL,
        harness,
        evidence: {
          message: harnessDoctor.message ?? `${harness} was requested but not detected.`
        }
      });
    }
  }

  const remoteCheck = await reachabilityCheck(options, deps);
  checks.push(remoteCheck);

  if (remoteCheck.code === REMOTE_REACHABLE) {
    checks.push({
      code: RUNTIME_PROBE_REQUIRED,
      result: CHECK_WARN,
      evidence: {
        state: "probe_pending",
        message: "Host doctor cannot prove authenticated runtime health.",
        next_action: "Run the in-harness doctor skill from a new session."
      }
    });
  }

  if (checks.some((check) => check.code === WARNING_AUTH_REQUIRED)) {
    warnings.push({
      code: WARNING_AUTH_REQUIRED,
      message: "Open a new Claude/Codex session and complete native OAuth."
    });
    nextSteps.push("Open a new session and run the doctor skill.");
  }

  if (checks.some((check) => check.code === WARNING_BINDING_REQUIRED)) {
    warnings.push({
      code: WARNING_BINDING_REQUIRED,
      message: BINDING_REQUIRED_NEXT_STEP
    });
    nextSteps.push(BINDING_REQUIRED_NEXT_STEP);
  }

  if (checks.some((check) => check.code === WARNING_REMOTE_UNREACHABLE)) {
    warnings.push({
      code: WARNING_REMOTE_UNREACHABLE,
      message: "Retry the doctor after the implant endpoint is reachable."
    });
  }

  if (checks.some((check) => check.code === RUNTIME_PROBE_REQUIRED)) {
    warnings.push({
      code: RUNTIME_PROBE_REQUIRED,
      message: "Open a new session and run the doctor skill to complete the authenticated probe."
    });
    nextSteps.push("Open a new session and run the doctor skill.");
  }

  if (checks.some((check) => check.code === "COWORK_PLUGIN_NOT_OBSERVED")) {
    warnings.push({
      code: "COWORK_PLUGIN_NOT_OBSERVED",
      message: "Local Cowork registration is not yet observable from Claude Desktop state."
    });
    nextSteps.unshift(
      `npx -y ${PACKAGE_NAME}@latest install --yes --harness cowork`,
      "After installation succeeds, fully quit Claude Desktop, reopen it, and start a new Local Cowork session."
    );
  }

  const summary = summarizeStatus(checks, selectedSupportedHarnessCount);
  const probeState = checks.some((check) => check.code === WARNING_AUTH_REQUIRED)
    ? "auth_required"
    : checks.some((check) => check.code === RUNTIME_PROBE_REQUIRED)
      ? "probe_pending"
      : checks.some((check) => check.code === WARNING_REMOTE_UNREACHABLE)
        ? "unreachable"
        : checks.some((check) => check.code === REMOTE_CONTRACT_INVALID)
          ? "invalid"
          : "not_run";

  return sanitizeValue({
    schema_version: 1,
    status: summary.status,
    version: PACKAGE_VERSION,
    package_name: PACKAGE_NAME,
    platform: process.platform,
    requested_harnesses: requestedHarnesses.includes(HARNESS_AUTO) ? [HARNESS_AUTO] : requestedHarnesses,
    detected_harnesses: detectionResult.detections,
    detected_harnesses_by_name: detectionResult.byHarness ?? {},
    remote_probe: {
      state: probeState,
      reachability: remoteCheck.evidence?.probe_state ?? "not_run"
    },
    checks,
    warnings,
    next_steps: [...new Set(nextSteps)],
    exit_code: summary.exit_code
  }, homeDirectory, stateRoot, verbose);
}
