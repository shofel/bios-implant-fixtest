import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION
} from "./constants.mjs";
import {
  EXIT_INSTALL_FAILURE,
  EXIT_NO_SUPPORTED_HARNESS,
  HARNESS_AUTO,
  HARNESS_CLAUDE,
  HARNESS_CODEX,
  HARNESS_COWORK,
  RESULT_FAIL,
  RESULT_PASS,
  RESULT_WARN,
  WARNING_BINDING_REQUIRED,
  WARNING_RUNTIME_PROBE_REQUIRED,
  aggregateHarnessExitCode,
  detectHarnesses,
  installHarness,
  requestedHarnessRepairCommand,
  resolveHarnesses,
  sanitizeHarnessError,
  selectRequestedHarnesses,
  uninstallHarness
} from "./harnesses.mjs";
import {
  atomicWriteJson,
  atomicReplaceDirectory,
  copyDirectory,
  packageRootFrom,
  stableJson
} from "./util.mjs";
import {
  ensureCodexOauthCallbackConfig,
  removeOwnedCodexOauthCallbackConfig
} from "./codex-oauth-config.mjs";
import {
  OWNERSHIP_LEDGER_RELATIVE_PATH,
  OWNERSHIP_OWNER_ID,
  readOwnershipLedger
} from "./store.mjs";
import { resolveCoworkProfile } from "./cowork-desktop.mjs";

const INSTALL_STATE_FILENAME = "install-state.json";
const WARNING_CATALOG_RETAINED = "CATALOG_RETAINED";
const WARNING_BINDING_INSPECTION_FAILED = "BINDING_INSPECTION_FAILED";
const WARNING_INSTALL_STATE_INVALID = "INSTALL_STATE_INVALID";
const WARNING_INSTALL_STATE_RETAINED = "INSTALL_STATE_RETAINED";
const WARNING_UNSAFE_STATE_PATH = "UNSAFE_STATE_PATH";
const FAILURE_CODEX_OAUTH_CALLBACK_CONFIG = "CODEX_OAUTH_CALLBACK_CONFIG_CONFLICT";
const WARNING_CODEX_OAUTH_CALLBACK_CONFIG_RETAINED = "CODEX_OAUTH_CALLBACK_CONFIG_RETAINED";
const LOCAL_MCP_LAUNCHER = "dist/local-mcp.mjs";
const INSTALL_STATE_MODE = 0o600;

function homeDirectoryFrom(options, deps) {
  return options.homeDirectory ?? deps.homeDirectory ?? deps.env?.HOME ?? os.homedir();
}

export function resolveInstallerStateRoot(options = {}, deps = {}) {
  const env = deps.env ?? process.env;
  if (typeof env.BIOS_IMPLANT_STATE_ROOT === "string" && env.BIOS_IMPLANT_STATE_ROOT.trim()) {
    return path.resolve(env.BIOS_IMPLANT_STATE_ROOT);
  }
  if (typeof env.AGENT_UNIVERSITY_HOME === "string" && env.AGENT_UNIVERSITY_HOME.trim()) {
    return path.resolve(env.AGENT_UNIVERSITY_HOME);
  }
  return path.join(homeDirectoryFrom(options, deps), ".agent-university");
}

function currentPackageRoot(deps) {
  return deps.packageRoot ?? packageRootFrom(import.meta.url);
}

function managedPaths(packageRoot, stateRoot) {
  const installHome = path.join(stateRoot, "bios-implant");
  return {
    packageRoot,
    stateRoot,
    installHome,
    catalogSourcePath: path.join(packageRoot, "catalog"),
    catalogPath: path.join(installHome, "catalog"),
    npmCachePath: path.join(installHome, "npm-cache"),
    installStatePath: path.join(installHome, INSTALL_STATE_FILENAME)
  };
}

async function ensurePackageArtifacts(paths, deps) {
  const fileSystem = deps.fs ?? fsp;
  const requiredPaths = [
    paths.catalogSourcePath,
    path.join(paths.catalogSourcePath, ".claude-plugin", "marketplace.json"),
    path.join(paths.packageRoot, ".claude-plugin", "plugin.json"),
    path.join(paths.packageRoot, ".claude-plugin", "marketplace.json"),
    path.join(paths.packageRoot, ".codex-plugin", "plugin.json"),
    path.join(paths.packageRoot, ".mcp.json"),
    path.join(paths.packageRoot, "SETUP.md"),
    path.join(paths.packageRoot, LOCAL_MCP_LAUNCHER),
    path.join(paths.packageRoot, "skills"),
    path.join(paths.packageRoot, "hooks"),
    path.join(paths.packageRoot, "scripts")
  ];

  for (const requiredPath of requiredPaths) {
    try {
      await fileSystem.access(requiredPath);
    } catch {
      throw new Error(`Missing packaged installer artifact: ${path.relative(paths.packageRoot, requiredPath)}`);
    }
  }
}

async function writeInstallState(installStatePath, stateRoot, value, deps) {
  const fileSystem = deps.fs ?? fsp;
  const pathInspection = await inspectManagedTargetPath(installStatePath, stateRoot, fileSystem);
  if (!pathInspection.safe) {
    throw unsafeManagedPathError(installStatePath, pathInspection);
  }
  const serialized = stableJson(value);
  const existing = await fileSystem.readFile(installStatePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existing === serialized) {
    return false;
  }
  await atomicWriteJson(installStatePath, value, { mode: INSTALL_STATE_MODE });
  return true;
}

async function readInstallState(installStatePath, deps) {
  const fileSystem = deps.fs ?? fsp;
  let source;
  try {
    source = await fileSystem.readFile(installStatePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: null, issue: null };
    }
    return {
      state: null,
      issue: {
        code: WARNING_INSTALL_STATE_INVALID,
        message: "Installer state could not be read; destructive ownership claims are disabled.",
        details: { path: installStatePath, error_code: error?.code ?? "READ_FAILED" }
      }
    };
  }

  try {
    const state = JSON.parse(source);
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new TypeError("install state must be an object");
    }
    return { state, issue: null };
  } catch (error) {
    return {
      state: null,
      issue: {
        code: WARNING_INSTALL_STATE_INVALID,
        message: "Installer state is malformed; destructive ownership claims are disabled.",
        details: { path: installStatePath, error: error?.message ?? "INVALID_JSON" }
      }
    };
  }
}

function normalizeRelativePath(value) {
  return String(value).split(path.sep).join("/");
}

async function hashFile(filePath, fileSystem) {
  const bytes = await fileSystem.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function snapshotDirectory(rootPath, fileSystem, relativePath = "") {
  const entries = await fileSystem.readdir(path.join(rootPath, relativePath), { withFileTypes: true });
  const snapshot = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const nextRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    const normalizedPath = normalizeRelativePath(nextRelativePath);

    if (entry.isDirectory()) {
      snapshot.push({ path: normalizedPath, kind: "dir" });
      snapshot.push(...(await snapshotDirectory(rootPath, fileSystem, nextRelativePath)));
      continue;
    }

    if (entry.isFile()) {
      snapshot.push({
        path: normalizedPath,
        kind: "file",
        digest_sha256: await hashFile(path.join(rootPath, nextRelativePath), fileSystem)
      });
      continue;
    }

    snapshot.push({ path: normalizedPath, kind: "other" });
  }

  return snapshot;
}

async function directoryContentChanged(sourcePath, targetPath, fileSystem) {
  const currentSnapshot = await snapshotDirectory(sourcePath, fileSystem);
  const targetSnapshot = await snapshotDirectory(targetPath, fileSystem).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (targetSnapshot == null) {
    return true;
  }

  return stableJson(currentSnapshot) !== stableJson(targetSnapshot);
}

function installStatePayload(materialization, result, previousState = null) {
  const ownership = previousState?.ownership && typeof previousState.ownership === "object"
    ? { ...previousState.ownership }
    : {};
  const codexResult = result.harnesses.find((entry) => entry.harness === HARNESS_CODEX);
  if (codexResult?.details?.mcp_created_by_installer === true && codexResult.details.mcp_ownership) {
    ownership.codex_mcp = codexResult.details.mcp_ownership;
  }
  const codexOauthAction = result.actions.find((entry) =>
    entry.type === "configure_codex_oauth_callback" && entry.ownership
  );
  if (codexOauthAction?.ownership) {
    ownership.codex_oauth_callback = codexOauthAction.ownership;
  }

  const payload = {
    package_name: PACKAGE_NAME,
    package_version: PACKAGE_VERSION,
    catalog_path: materialization.catalog_path,
    harnesses: result.harnesses.map((entry) => ({
      harness: entry.harness,
      result: entry.result,
      code: entry.code,
      catalog_registration: entry.details?.marketplace ?? null
    }))
  };
  if (Object.keys(ownership).length) {
    payload.ownership = ownership;
  }
  return payload;
}

function selectedHarnessesForDeps(requestedHarnesses, detectionResult) {
  return requestedHarnesses.length === 1 && requestedHarnesses[0] === HARNESS_AUTO
    ? detectionResult.detections.filter((entry) => entry.detected).map((entry) => entry.harness)
    : requestedHarnesses;
}

async function fileDigestMatches(filePath, expectedDigest, fileSystem) {
  try {
    return (await hashFile(filePath, fileSystem)) === expectedDigest;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeManagedFileIfExists(filePath, stateRoot, fileSystem) {
  try {
    await fileSystem.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { safe: true, changed: false, state: "absent", path: filePath };
    }
    throw error;
  }

  const pathInspection = await inspectOwnedTargetPath(filePath, stateRoot, fileSystem);
  if (!pathInspection.safe) {
    return { safe: false, changed: false, state: pathInspection.reason, path: filePath };
  }
  await fileSystem.rm(filePath, { force: true });
  try {
    await fileSystem.lstat(filePath);
    return { safe: false, changed: false, state: "verification_failed", path: filePath };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return { safe: true, changed: true, state: "removed", path: filePath };
}

function isWithinStateRoot(candidatePath, stateRoot) {
  const relativePath = path.relative(stateRoot, candidatePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function isWithinCanonicalRoot(candidatePath, canonicalRoot) {
  const relativePath = path.relative(canonicalRoot, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function unsafeManagedPathError(targetPath, inspection) {
  const error = new Error(`Unsafe managed state path (${inspection.reason ?? "unknown"}): ${targetPath}`);
  error.code = WARNING_UNSAFE_STATE_PATH;
  error.details = { target_path: targetPath, ...inspection };
  return error;
}

async function inspectStateRootCreationAnchor(stateRoot, fileSystem) {
  let currentPath = path.resolve(stateRoot);
  const missingSegments = [];

  while (true) {
    let stat;
    try {
      stat = await fileSystem.lstat(currentPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return { safe: false, reason: error?.code === "ENOTDIR" ? "non_directory_ancestor" : "state_root_unreadable" };
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return { safe: false, reason: "state_root_unreadable" };
      }
      missingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
      continue;
    }

    if (stat.isSymbolicLink()) {
      return { safe: false, reason: "state_root_ancestor_symlink", ancestor_path: currentPath };
    }
    if (!stat.isDirectory()) {
      return { safe: false, reason: "non_directory_ancestor", ancestor_path: currentPath };
    }

    try {
      return {
        safe: true,
        reason: missingSegments.length ? "state_root_missing" : "state_root_exists",
        anchor_path: currentPath,
        canonical_anchor: await fileSystem.realpath(currentPath),
        missing_segments: missingSegments
      };
    } catch {
      return { safe: false, reason: "state_root_unreadable", ancestor_path: currentPath };
    }
  }
}

async function inspectManagedTargetPath(targetPath, stateRoot, fileSystem) {
  const resolvedRoot = path.resolve(stateRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { safe: false, reason: "outside_state_root" };
  }

  let rootStat;
  try {
    rootStat = await fileSystem.lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const creationAnchor = await inspectStateRootCreationAnchor(resolvedRoot, fileSystem);
      if (!creationAnchor.safe) {
        return creationAnchor;
      }
      return {
        safe: true,
        reason: "state_root_missing",
        creation_anchor: creationAnchor.anchor_path,
        canonical_anchor: creationAnchor.canonical_anchor
      };
    }
    return { safe: false, reason: "state_root_unreadable" };
  }
  if (rootStat.isSymbolicLink()) {
    return { safe: false, reason: "state_root_symlink" };
  }
  if (!rootStat.isDirectory()) {
    return { safe: false, reason: "state_root_not_directory" };
  }

  let canonicalRoot;
  try {
    canonicalRoot = await fileSystem.realpath(resolvedRoot);
  } catch {
    return { safe: false, reason: "state_root_unreadable" };
  }

  const segments = relativePath.split(path.sep).filter(Boolean);
  let currentPath = resolvedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    let stat;
    try {
      stat = await fileSystem.lstat(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { safe: true, reason: "path_missing", canonical_root: canonicalRoot };
      }
      return { safe: false, reason: "path_unreadable", canonical_root: canonicalRoot };
    }
    if (stat.isSymbolicLink()) {
      return { safe: false, reason: "symlink_traversal", canonical_root: canonicalRoot };
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return { safe: false, reason: "non_directory_parent", canonical_root: canonicalRoot };
    }

    let canonicalCurrent;
    try {
      canonicalCurrent = await fileSystem.realpath(currentPath);
    } catch {
      return { safe: false, reason: "path_unreadable", canonical_root: canonicalRoot };
    }
    if (!isWithinCanonicalRoot(canonicalCurrent, canonicalRoot)) {
      return { safe: false, reason: "resolved_outside_state_root", canonical_root: canonicalRoot };
    }
  }

  return { safe: true, reason: "verified", canonical_root: canonicalRoot };
}

async function ensureManagedDirectory(directoryPath, stateRoot, fileSystem) {
  const resolvedRoot = path.resolve(stateRoot);
  const resolvedDirectory = path.resolve(directoryPath);
  const relativePath = path.relative(resolvedRoot, resolvedDirectory);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw unsafeManagedPathError(directoryPath, { safe: false, reason: "outside_state_root" });
  }

  const creationPlan = await inspectStateRootCreationAnchor(resolvedRoot, fileSystem);
  if (!creationPlan.safe) {
    throw unsafeManagedPathError(resolvedRoot, creationPlan);
  }

  let creationParent = creationPlan.anchor_path;
  for (const segment of creationPlan.missing_segments) {
    const parentStat = await fileSystem.lstat(creationParent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw unsafeManagedPathError(creationParent, {
        safe: false,
        reason: parentStat.isSymbolicLink() ? "state_root_ancestor_symlink" : "non_directory_ancestor"
      });
    }
    const canonicalParent = await fileSystem.realpath(creationParent);
    if (!isWithinCanonicalRoot(canonicalParent, creationPlan.canonical_anchor)) {
      throw unsafeManagedPathError(creationParent, {
        safe: false,
        reason: "resolved_outside_creation_anchor"
      });
    }

    const nextPath = path.join(creationParent, segment);
    try {
      await fileSystem.mkdir(nextPath);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    const nextStat = await fileSystem.lstat(nextPath);
    if (nextStat.isSymbolicLink() || !nextStat.isDirectory()) {
      throw unsafeManagedPathError(nextPath, {
        safe: false,
        reason: nextStat.isSymbolicLink() ? "state_root_ancestor_symlink" : "non_directory_ancestor"
      });
    }
    const canonicalNext = await fileSystem.realpath(nextPath);
    if (!isWithinCanonicalRoot(canonicalNext, creationPlan.canonical_anchor)) {
      throw unsafeManagedPathError(nextPath, {
        safe: false,
        reason: "resolved_outside_creation_anchor"
      });
    }
    creationParent = nextPath;
  }

  const rootInspection = await inspectManagedTargetPath(resolvedRoot, resolvedRoot, fileSystem);
  if (!rootInspection.safe) {
    throw unsafeManagedPathError(resolvedRoot, rootInspection);
  }

  let currentPath = resolvedRoot;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      await fileSystem.mkdir(currentPath);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const inspection = await inspectManagedTargetPath(currentPath, resolvedRoot, fileSystem);
    if (!inspection.safe) {
      throw unsafeManagedPathError(currentPath, inspection);
    }
    const stat = await fileSystem.lstat(currentPath);
    if (!stat.isDirectory()) {
      throw unsafeManagedPathError(currentPath, { safe: false, reason: "managed_path_not_directory" });
    }
  }
}

function failUnsafeStatePath(result, targetPath, inspection) {
  result.status = RESULT_FAIL;
  result.exit_code = EXIT_INSTALL_FAILURE;
  result.warnings.push({
    code: WARNING_UNSAFE_STATE_PATH,
    message: "Refused to access installer state through a symlinked or unsafe managed path.",
    details: { target_path: targetPath, reason: inspection.reason ?? "unknown" }
  });
  result.next_steps.push("Replace the managed state symlink with a real directory, then rerun the command.");
  return result;
}

async function inspectOwnedTargetPath(targetPath, stateRoot, fileSystem) {
  let canonicalRoot;
  try {
    const rootStat = await fileSystem.lstat(stateRoot);
    if (rootStat.isSymbolicLink()) {
      return { safe: false, reason: "state_root_symlink" };
    }
    canonicalRoot = await fileSystem.realpath(stateRoot);
  } catch (error) {
    return { safe: false, reason: error?.code === "ENOENT" ? "state_root_missing" : "state_root_unreadable" };
  }

  if (!isWithinStateRoot(targetPath, stateRoot)) {
    return { safe: false, reason: "outside_state_root" };
  }

  const relativePath = path.relative(stateRoot, targetPath);
  const segments = relativePath.split(path.sep).filter(Boolean);
  let currentPath = stateRoot;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    let stat;
    try {
      stat = await fileSystem.lstat(currentPath);
    } catch (error) {
      return {
        safe: false,
        reason: error?.code === "ENOENT" ? "target_missing" : "path_unreadable"
      };
    }
    if (stat.isSymbolicLink()) {
      return { safe: false, reason: "symlink_traversal" };
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return { safe: false, reason: "non_directory_parent" };
    }
  }

  let canonicalTarget;
  try {
    canonicalTarget = await fileSystem.realpath(targetPath);
  } catch (error) {
    return { safe: false, reason: error?.code === "ENOENT" ? "target_missing" : "path_unreadable" };
  }
  if (!isWithinCanonicalRoot(canonicalTarget, canonicalRoot)) {
    return { safe: false, reason: "resolved_outside_state_root" };
  }

  return { safe: true, canonical_root: canonicalRoot, canonical_target: canonicalTarget };
}

async function pruneEmptyParents(startPath, stopPath, fileSystem) {
  let currentPath = path.dirname(startPath);

  while (currentPath.startsWith(`${stopPath}${path.sep}`)) {
    const entries = await fileSystem.readdir(currentPath).catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!entries || entries.length > 0) {
      break;
    }
    await fileSystem.rmdir(currentPath).catch(() => {});
    currentPath = path.dirname(currentPath);
  }
}

async function purgeOwnedState(paths, options, deps) {
  const fileSystem = deps.fs ?? fsp;
  const ledgerRecords = await readOwnershipLedger({ stateRoot: paths.stateRoot }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const lastRecordByPath = new Map();
  for (const record of ledgerRecords) {
    if (record?.owner !== OWNERSHIP_OWNER_ID || typeof record?.relative_path !== "string") {
      continue;
    }
    lastRecordByPath.set(record.relative_path, record);
  }

  const deleted = [];
  const retained = [];
  for (const record of lastRecordByPath.values()) {
    const targetPath = path.join(paths.stateRoot, ...record.relative_path.split("/"));
    const pathInspection = await inspectOwnedTargetPath(targetPath, paths.stateRoot, fileSystem);
    if (!pathInspection.safe) {
      retained.push({ path: record.relative_path, reason: pathInspection.reason });
      continue;
    }
    if (!(await fileDigestMatches(targetPath, record.digest_sha256, fileSystem))) {
      retained.push({ path: record.relative_path, reason: "digest_mismatch_or_missing" });
      continue;
    }
    deleted.push({ targetPath, relativePath: record.relative_path, digest: record.digest_sha256 });
  }

  if (options.dryRun) {
    return {
      deleted_paths: deleted.map((entry) => path.relative(paths.stateRoot, entry.targetPath)),
      retained
    };
  }

  const removed = [];
  for (const entry of deleted) {
    const pathInspection = await inspectOwnedTargetPath(entry.targetPath, paths.stateRoot, fileSystem);
    if (!pathInspection.safe || !(await fileDigestMatches(entry.targetPath, entry.digest, fileSystem))) {
      retained.push({
        path: entry.relativePath,
        reason: pathInspection.safe ? "digest_changed_before_remove" : pathInspection.reason
      });
      continue;
    }
    await fileSystem.rm(entry.targetPath, { force: true });
    await pruneEmptyParents(entry.targetPath, paths.stateRoot, fileSystem);
    removed.push(entry.targetPath);
  }

  return {
    deleted_paths: removed.map((entry) => path.relative(paths.stateRoot, entry)),
    retained
  };
}

function hasRuntimeProbeWarning(result) {
  return result.harnesses.some((entry) =>
    (entry.warnings ?? []).some((warning) => warning.code === WARNING_RUNTIME_PROBE_REQUIRED)
  );
}

function hasAuthWarning(result) {
  return result.harnesses.some((entry) =>
    (entry.warnings ?? []).some((warning) => warning.code === "AUTH_REQUIRED")
  );
}

export async function materializeCatalog(options = {}, deps = {}) {
  const packageRoot = currentPackageRoot(deps);
  const stateRoot = resolveInstallerStateRoot(options, deps);
  const paths = managedPaths(packageRoot, stateRoot);
  const fileSystem = deps.fs ?? fsp;
  const copyDir = deps.copyDirectory ?? copyDirectory;
  const replaceDir = deps.atomicReplaceDirectory ?? atomicReplaceDirectory;

  await ensurePackageArtifacts(paths, deps);
  const installHomeInspection = await inspectManagedTargetPath(paths.installHome, paths.stateRoot, fileSystem);
  if (!installHomeInspection.safe) {
    throw unsafeManagedPathError(paths.installHome, installHomeInspection);
  }
  if (!options.dryRun) {
    await ensureManagedDirectory(paths.installHome, paths.stateRoot, fileSystem);
  }
  const catalogInspection = await inspectManagedTargetPath(paths.catalogPath, paths.stateRoot, fileSystem);
  if (!catalogInspection.safe) {
    throw unsafeManagedPathError(paths.catalogPath, catalogInspection);
  }
  const changed = await directoryContentChanged(paths.catalogSourcePath, paths.catalogPath, fileSystem);
  if (options.dryRun) {
    return {
      changed,
      catalog_path: paths.catalogPath
    };
  }
  if (!changed) {
    return {
      changed: false,
      catalog_path: paths.catalogPath
    };
  }

  const temporaryCatalogPath = path.join(
    paths.installHome,
    `.catalog.${process.pid}.${crypto.randomUUID()}.tmp`
  );

  await copyDir(paths.catalogSourcePath, temporaryCatalogPath);
  await replaceDir(temporaryCatalogPath, paths.catalogPath);

  return {
    changed: true,
    catalog_path: paths.catalogPath
  };
}

async function inspectBindingState(stateRoot, deps) {
  const fileSystem = deps.fs ?? fsp;
  const biosRoot = path.join(stateRoot, "bios");
  const bindingRoot = path.join(biosRoot, "projects");

  let entries;
  try {
    entries = await fileSystem.readdir(bindingRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { has_binding: false, bindings: [], issues: [] };
    }
    return {
      has_binding: false,
      bindings: [],
      issues: [{
        path: bindingRoot,
        reason: "binding_root_unreadable",
        error_code: error?.code ?? "READ_FAILED"
      }]
    };
  }

  const bindings = [];
  const issues = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const bindingPath = path.join(bindingRoot, entry.name, "binding.json");
    let source;
    try {
      source = await fileSystem.readFile(bindingPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        issues.push({
          path: bindingPath,
          reason: "binding_unreadable",
          error_code: error?.code ?? "READ_FAILED"
        });
      }
      continue;
    }

    try {
      const binding = JSON.parse(source);
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new TypeError("binding must be an object");
      }
      bindings.push({ path: bindingPath, binding });
    } catch (error) {
      issues.push({
        path: bindingPath,
        reason: "binding_malformed",
        error: error?.message ?? "INVALID_JSON"
      });
    }
  }

  return { has_binding: bindings.length > 0, bindings, issues };
}

function createResult(command, options, packageRoot, homeDirectory, requestedHarnesses) {
  return {
    command,
    requested_harnesses: requestedHarnesses,
    status: RESULT_PASS,
    version: PACKAGE_VERSION,
    package_name: PACKAGE_NAME,
    package_root: packageRoot,
    home_directory: homeDirectory,
    dry_run: Boolean(options.dryRun),
    changed: false,
    actions: [],
    harnesses: [],
    warnings: [],
    next_steps: [],
    exit_code: 0
  };
}

function finalizeResult(result) {
  const harnessExitCode = aggregateHarnessExitCode(result.harnesses);
  if (result.status !== RESULT_FAIL) {
    const failedHarnesses = result.harnesses.filter((entry) => entry.result === RESULT_FAIL);
    const warnedHarnesses = result.harnesses.filter((entry) => entry.result === RESULT_WARN);

    if (failedHarnesses.length) {
      result.status = RESULT_FAIL;
      result.exit_code = EXIT_INSTALL_FAILURE;
      result.next_steps.push(
        requestedHarnessRepairCommand(
          `npx -y ${PACKAGE_NAME}@latest ${result.command} --yes`,
          failedHarnesses.map((entry) => entry.harness)
        )
      );
    } else if (warnedHarnesses.length || result.warnings.length) {
      result.status = RESULT_WARN;
      result.exit_code = result.command === "doctor" ? 2 : 0;
    } else {
      result.status = RESULT_PASS;
      result.exit_code = harnessExitCode;
    }
  }

  return result;
}

async function performInstall(options, deps) {
  const packageRoot = currentPackageRoot(deps);
  const homeDirectory = homeDirectoryFrom(options, deps);
  const stateRoot = resolveInstallerStateRoot(options, deps);
  const paths = managedPaths(packageRoot, stateRoot);
  const requestedHarnesses = resolveHarnesses(options.harnesses ?? []);
  const result = createResult("install", options, packageRoot, homeDirectory, requestedHarnesses);
  const statePathInspection = await inspectManagedTargetPath(
    paths.installStatePath,
    paths.stateRoot,
    deps.fs ?? fsp
  );
  if (!statePathInspection.safe) {
    return failUnsafeStatePath(result, paths.installStatePath, statePathInspection);
  }
  const installStateRead = await readInstallState(paths.installStatePath, deps);
  if (installStateRead.issue) {
    result.warnings.push(installStateRead.issue);
  }

  const detectionResult = await detectHarnesses({ ...options, homeDirectory }, deps);
  const selectedHarnesses = selectRequestedHarnesses(requestedHarnesses, detectionResult);
  result.detected_harnesses = detectionResult.detections;

  if (requestedHarnesses.includes(HARNESS_AUTO) && !selectedHarnesses.length) {
    result.status = RESULT_FAIL;
    result.exit_code = EXIT_NO_SUPPORTED_HARNESS;
    result.next_steps.push(`Install Claude or Codex, then rerun npx -y ${PACKAGE_NAME}@latest install --yes`);
    return result;
  }

  const materialization = await materializeCatalog(options, { ...deps, packageRoot });
  result.changed = materialization.changed;
  result.actions.push({
    type: "materialize_catalog",
    catalog_path: materialization.catalog_path,
    changed: materialization.changed
  });

  let codexOauthConfig = null;
  if (selectedHarnesses.includes(HARNESS_CODEX)) {
    codexOauthConfig = await ensureCodexOauthCallbackConfig({
      homeDirectory,
      env: deps.env ?? process.env,
      dryRun: options.dryRun
    }, deps);
    result.actions.push({
      type: "configure_codex_oauth_callback",
      ...codexOauthConfig
    });
    result.changed = result.changed || Boolean(codexOauthConfig.changed);
  }

  let coworkProfile = null;
  if (selectedHarnesses.includes(HARNESS_COWORK)) {
    const resolveProfile = deps.resolveCoworkProfile ?? resolveCoworkProfile;
    coworkProfile = await resolveProfile({
      homeDirectory,
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
      fileSystem: deps.fs ?? fsp
    });
    result.actions.push({
      type: "resolve_cowork_profile",
      ok: coworkProfile.ok,
      source: coworkProfile.source,
      config_dir: coworkProfile.config_dir ?? null
    });
  }

  for (const harness of selectedHarnesses) {
    const detection = detectionResult.byHarness[harness];
    try {
      if (harness === HARNESS_CODEX && codexOauthConfig && !codexOauthConfig.ok) {
        result.harnesses.push({
          harness,
          result: RESULT_FAIL,
          code: FAILURE_CODEX_OAUTH_CALLBACK_CONFIG,
          message: "Codex has a conflicting MCP OAuth callback configuration; it was preserved.",
          changed: false,
          commands: [],
          details: { oauth_callback_config: codexOauthConfig },
          warnings: [],
          next_steps: [
            "Review the saved report, resolve the existing Codex MCP OAuth callback settings, then rerun installation."
          ]
        });
        continue;
      }
      const harnessResult = await installHarness(
        {
          harness,
          detection,
          catalogPath: materialization.catalog_path,
          dryRun: options.dryRun,
          mcpOwnership: installStateRead.state?.ownership?.codex_mcp ?? null,
          coworkProfile: harness === HARNESS_COWORK ? coworkProfile : null,
          npmCachePath: harness === HARNESS_COWORK ? paths.npmCachePath : null
        },
        { ...deps, options }
      );
      if (harness === HARNESS_CODEX && codexOauthConfig) {
        harnessResult.details = {
          ...(harnessResult.details ?? {}),
          oauth_callback_config: {
            state: codexOauthConfig.state,
            config_path: codexOauthConfig.config_path,
            callback_port: codexOauthConfig.callback_port,
            callback_url: codexOauthConfig.callback_url,
            redirect_uri: codexOauthConfig.redirect_uri
          }
        };
      }
      result.harnesses.push(harnessResult);
      result.changed = result.changed || Boolean(harnessResult.changed);
    } catch (error) {
      result.harnesses.push({
        harness,
        ...sanitizeHarnessError(error),
        commands: [],
        warnings: [],
        next_steps: []
      });
    }
  }

  const bindingState = await inspectBindingState(stateRoot, deps);
  for (const issue of bindingState.issues) {
    result.warnings.push({
      code: WARNING_BINDING_INSPECTION_FAILED,
      message: "A Folder Binding exists but could not be validated.",
      details: issue
    });
  }
  const successfulHarnesses = result.harnesses.filter((entry) => entry.result !== RESULT_FAIL);
  if (successfulHarnesses.length) {
    if (!bindingState.has_binding) {
      result.warnings.push({
        code: WARNING_BINDING_REQUIRED,
        message: "Run the connect flow in the intended workspace."
      });
    }
    if (hasAuthWarning(result)) {
      result.warnings.push({
        code: "AUTH_REQUIRED",
        message: "Open a new harness session, run the doctor flow, and complete native OAuth only if prompted."
      });
    }
    if (hasRuntimeProbeWarning(result)) {
      result.warnings.push({
        code: WARNING_RUNTIME_PROBE_REQUIRED,
        message: "Open a new session and run the doctor skill to complete the authenticated runtime probe."
      });
    }
    result.next_steps.push(
      "Finish BIOS Implant setup: run the doctor skill, complete native OAuth if prompted, verify the Local Companion, and report the current Folder Binding."
    );
  }

  if (!options.dryRun) {
    const installStatePath = paths.installStatePath;
    const stateWriteInspection = await inspectManagedTargetPath(
      installStatePath,
      paths.stateRoot,
      deps.fs ?? fsp
    );
    if (!stateWriteInspection.safe) {
      return failUnsafeStatePath(result, installStatePath, stateWriteInspection);
    }
    const installStateChanged = await writeInstallState(
      installStatePath,
      paths.stateRoot,
      installStatePayload(materialization, result, installStateRead.state),
      deps
    );
    result.changed = result.changed || installStateChanged;
    result.actions.push({
      type: "write_install_state",
      path: installStatePath,
      changed: installStateChanged
    });
  }

  return finalizeResult(result);
}

function effectiveHarnessName(harness) {
  return harness;
}

function requiredUninstallHarnesses(selectedHarnesses, installState) {
  const required = new Set(selectedHarnesses.map(effectiveHarnessName));
  for (const entry of installState?.harnesses ?? []) {
    if (entry?.result === RESULT_FAIL) {
      continue;
    }
    const harness = effectiveHarnessName(entry?.harness);
    if (harness === HARNESS_COWORK || harness === HARNESS_CLAUDE || harness === HARNESS_CODEX) {
      required.add(harness);
    }
  }
  return [...required];
}

function uninstallResultByEffectiveHarness(results, harness) {
  return results.find((entry) => effectiveHarnessName(entry.harness) === harness) ?? null;
}

async function persistentCatalogExists(catalogPath, fileSystem) {
  try {
    await fileSystem.lstat(catalogPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function reconcilePersistentCatalog(paths, installState, registrationsSafe, options, deps) {
  const fileSystem = deps.fs ?? fsp;
  const exists = await persistentCatalogExists(paths.catalogPath, fileSystem);
  if (!exists) {
    return { safe: true, changed: false, state: "absent", path: paths.catalogPath };
  }

  const catalogOwned = Boolean(
    installState?.package_name === PACKAGE_NAME &&
    path.resolve(installState.catalog_path ?? "") === path.resolve(paths.catalogPath)
  );
  if (!registrationsSafe || !catalogOwned) {
    return {
      safe: false,
      changed: false,
      state: registrationsSafe ? "ownership_unproven" : "registration_retained",
      path: paths.catalogPath,
      catalog_owned: catalogOwned
    };
  }

  if (!isWithinStateRoot(paths.catalogPath, paths.stateRoot)) {
    return {
      safe: false,
      changed: false,
      state: "path_outside_state_root",
      path: paths.catalogPath,
      catalog_owned: catalogOwned
    };
  }

  const pathInspection = await inspectOwnedTargetPath(paths.catalogPath, paths.stateRoot, fileSystem);
  if (!pathInspection.safe) {
    return {
      safe: false,
      changed: false,
      state: pathInspection.reason,
      path: paths.catalogPath,
      catalog_owned: catalogOwned
    };
  }

  if (options.dryRun) {
    return { safe: true, changed: true, state: "would_remove", path: paths.catalogPath };
  }

  const removalInspection = await inspectOwnedTargetPath(paths.catalogPath, paths.stateRoot, fileSystem);
  if (!removalInspection.safe) {
    return {
      safe: false,
      changed: false,
      state: removalInspection.reason,
      path: paths.catalogPath,
      catalog_owned: catalogOwned
    };
  }
  await fileSystem.rm(paths.catalogPath, { recursive: true, force: true });
  if (await persistentCatalogExists(paths.catalogPath, fileSystem)) {
    return { safe: false, changed: false, state: "verification_failed", path: paths.catalogPath };
  }
  return { safe: true, changed: true, state: "removed", path: paths.catalogPath };
}

async function performUninstall(options, deps) {
  const packageRoot = currentPackageRoot(deps);
  const homeDirectory = homeDirectoryFrom(options, deps);
  const stateRoot = resolveInstallerStateRoot(options, deps);
  const requestedHarnesses = resolveHarnesses(options.harnesses ?? []);
  const result = createResult("uninstall", options, packageRoot, homeDirectory, requestedHarnesses);
  const paths = managedPaths(packageRoot, stateRoot);
  const statePathInspection = await inspectManagedTargetPath(
    paths.installStatePath,
    paths.stateRoot,
    deps.fs ?? fsp
  );
  if (!statePathInspection.safe) {
    return failUnsafeStatePath(result, paths.installStatePath, statePathInspection);
  }
  const installStateRead = await readInstallState(paths.installStatePath, deps);
  if (installStateRead.issue) {
    result.warnings.push(installStateRead.issue);
  }
  const detectionResult = await detectHarnesses({ ...options, homeDirectory }, deps);
  const selectedHarnesses = selectRequestedHarnesses(requestedHarnesses, detectionResult);
  result.detected_harnesses = detectionResult.detections;

  let coworkProfile = null;
  if (selectedHarnesses.includes(HARNESS_COWORK)) {
    const resolveProfile = deps.resolveCoworkProfile ?? resolveCoworkProfile;
    coworkProfile = await resolveProfile({
      homeDirectory,
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
      fileSystem: deps.fs ?? fsp
    });
    result.actions.push({
      type: "resolve_cowork_profile",
      ok: coworkProfile.ok,
      source: coworkProfile.source,
      config_dir: coworkProfile.config_dir ?? null
    });
  }

  for (const harness of selectedHarnesses) {
    const detection = detectionResult.byHarness[harness];
    try {
      const harnessResult = await uninstallHarness({
        harness,
        detection,
        catalogPath: paths.catalogPath,
        dryRun: options.dryRun,
        mcpOwnership: installStateRead.state?.ownership?.codex_mcp ?? null,
        coworkProfile: harness === HARNESS_COWORK ? coworkProfile : null,
        npmCachePath: harness === HARNESS_COWORK ? paths.npmCachePath : null
      }, { ...deps, options });
      result.harnesses.push(harnessResult);
      result.changed = result.changed || Boolean(harnessResult.changed);
    } catch (error) {
      result.harnesses.push({
        harness,
        ...sanitizeHarnessError(error),
        commands: [],
        warnings: [],
        next_steps: []
      });
    }
  }

  const requiredHarnesses = requiredUninstallHarnesses(
    selectedHarnessesForDeps(requestedHarnesses, detectionResult),
    installStateRead.state
  );
  const registrationsSafe = requiredHarnesses.length > 0 && requiredHarnesses.every((harness) => {
    const harnessResult = uninstallResultByEffectiveHarness(result.harnesses, harness);
    return harnessResult?.details?.catalog_removal?.safe === true;
  });
  const harnessCleanupSafe = requiredHarnesses.length > 0 && requiredHarnesses.every((harness) => {
    const harnessResult = uninstallResultByEffectiveHarness(result.harnesses, harness);
    return harnessResult?.details?.cleanup_safe === true;
  });

  let codexOauthRemoval = {
    safe: true,
    changed: false,
    state: "not_owned"
  };
  const codexOauthOwnership = installStateRead.state?.ownership?.codex_oauth_callback ?? null;
  if (harnessCleanupSafe && codexOauthOwnership) {
    codexOauthRemoval = await removeOwnedCodexOauthCallbackConfig({
      homeDirectory,
      env: deps.env ?? process.env,
      ownership: codexOauthOwnership,
      dryRun: options.dryRun
    }, deps);
    result.actions.push({
      type: codexOauthRemoval.safe
        ? "remove_codex_oauth_callback"
        : "retain_codex_oauth_callback",
      ...codexOauthRemoval
    });
    result.changed = result.changed || Boolean(codexOauthRemoval.changed);
    if (!codexOauthRemoval.safe) {
      result.warnings.push({
        code: WARNING_CODEX_OAUTH_CALLBACK_CONFIG_RETAINED,
        message: "Retained Codex OAuth callback settings because installer ownership or current values could not be proven.",
        details: codexOauthRemoval
      });
    }
  }
  const cleanupSafe = harnessCleanupSafe && codexOauthRemoval.safe;

  if (options.purgeData) {
    result.actions.push({
      type: "purge_state",
      path: paths.stateRoot,
      managed: true
    });
  }

  const catalogRemoval = await reconcilePersistentCatalog(
    paths,
    installStateRead.state,
    registrationsSafe,
    options,
    deps
  );
  result.actions.push({
    type: catalogRemoval.safe ? "remove_catalog" : "retain_catalog",
    managed: true,
    ...catalogRemoval
  });
  result.changed = result.changed || Boolean(catalogRemoval.changed);
  if (!catalogRemoval.safe) {
    result.warnings.push({
      code: WARNING_CATALOG_RETAINED,
      message: "Retained the persistent catalog because exact marketplace cleanup or catalog ownership was not proven.",
      details: catalogRemoval
    });
  }

  if (!options.dryRun) {
    if (options.purgeData) {
      const purgeResult = await purgeOwnedState(paths, options, deps);
      result.actions.push({
        type: "purged_owned_state",
        deleted_count: purgeResult.deleted_paths.length,
        retained_count: purgeResult.retained.length,
        ledger_path: path.join(paths.stateRoot, OWNERSHIP_LEDGER_RELATIVE_PATH)
      });
      if (purgeResult.retained.length) {
        result.warnings.push({
          code: "PURGE_RETAINED_PATHS",
          message: "Some BIOS Implant state was retained because ownership could not be proven or the on-disk digest changed.",
          details: { count: purgeResult.retained.length }
        });
      }
      result.changed = result.changed || purgeResult.deleted_paths.length > 0;
    }

    if (cleanupSafe && catalogRemoval.safe && installStateRead.state) {
      const installStateRemoval = await removeManagedFileIfExists(
        paths.installStatePath,
        paths.stateRoot,
        deps.fs ?? fsp
      );
      result.changed = result.changed || installStateRemoval.changed;
      result.actions.push({
        type: installStateRemoval.safe ? "remove_install_state" : "retain_install_state",
        ...installStateRemoval
      });
      if (!installStateRemoval.safe) {
        result.warnings.push({
          code: WARNING_INSTALL_STATE_RETAINED,
          message: "Retained installer ownership state because its managed path became unsafe.",
          details: installStateRemoval
        });
      }
    } else if (installStateRead.state) {
      result.warnings.push({
        code: WARNING_INSTALL_STATE_RETAINED,
        message: "Retained installer ownership state because harness cleanup is incomplete.",
        details: { required_harnesses: requiredHarnesses, cleanup_safe: cleanupSafe }
      });
    }
  } else if (options.purgeData) {
    const purgeResult = await purgeOwnedState(paths, options, deps);
    result.actions.push({
      type: "purged_owned_state",
      deleted_count: purgeResult.deleted_paths.length,
      retained_count: purgeResult.retained.length,
      ledger_path: path.join(paths.stateRoot, OWNERSHIP_LEDGER_RELATIVE_PATH)
    });
    result.changed = result.changed || purgeResult.deleted_paths.length > 0;
  }

  return finalizeResult(result);
}

export async function runInstaller(command, options = {}, deps = {}) {
  if (command === "install") {
    return performInstall(options, deps);
  }

  if (command === "uninstall") {
    return performUninstall(options, deps);
  }

  throw new Error(`Unsupported installer command: ${command}`);
}
