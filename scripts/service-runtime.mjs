#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.resolve(scriptDir, "..");
export const frontendDir = path.join(rootDir, "frontend");
export const aiServiceDir = path.join(rootDir, "ai-service");
export const superappServiceDir = path.join(rootDir, "superapp-service");
export const livekitAgentDir = path.join(rootDir, "livekit-agent");
export const logDir = path.join(rootDir, ".omx", "logs", "split-services");
export const pidDir = path.join(rootDir, ".omx", "state", "split-services");
export const localNodeRuntimeDir = path.join(rootDir, ".tools", "node-runtime");
export const localLivekitRuntimeDir = path.join(rootDir, ".tools", "livekit-runtime");

const envFiles = [".env", ".env.local"].map((file) => path.join(rootDir, file));
const trackedServices = ["livekit-server", "ai-service", "bff", "superapp-service", "livekit-agent", "frontend"];

export const isWindows = process.platform === "win32";
export const npmCommand = isWindows ? "npm.cmd" : "npm";
export const localLivekitPort = 7880;
export const localLivekitWsUrl = `ws://127.0.0.1:${localLivekitPort}`;
export const localLivekitHttpUrl = `http://127.0.0.1:${localLivekitPort}`;
export const localLivekitApiKey = "devkey";
export const localLivekitApiSecret = "secret";

function compareVersions(left, right) {
  const leftParts = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  const commentIndex = trimmed.search(/\s+#/);
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}

function parseEnvFile(contents) {
  const entries = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    entries[key] = parseEnvValue(normalized.slice(separatorIndex + 1));
  }
  return entries;
}

export function loadRuntimeEnv(baseEnv = process.env) {
  const loadedEntries = {};
  for (const envFile of envFiles) {
    if (!existsSync(envFile)) {
      continue;
    }
    Object.assign(loadedEntries, parseEnvFile(readFileSync(envFile, "utf8")));
  }
  return {
    ...baseEnv,
    ...loadedEntries,
  };
}

function spawnSyncQuiet(command, args) {
  try {
    return spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (error) {
    return {
      status: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function commandWorks(command, args) {
  const result = spawnSyncQuiet(command, args);
  return result.status === 0;
}

function resolveNodeExecutable(candidate) {
  if (!candidate) {
    return null;
  }

  const normalized = String(candidate).trim();
  if (!normalized) {
    return null;
  }

  if (existsSync(normalized)) {
    const nestedExecutable = path.join(normalized, isWindows ? "node.exe" : path.join("bin", "node"));
    return existsSync(nestedExecutable) ? nestedExecutable : normalized;
  }

  return normalized;
}

function inspectNodeRuntime(executable) {
  const result = spawnSyncQuiet(executable, ["-p", "process.versions.node"]);
  if (result.status !== 0) {
    return null;
  }

  const version = result.stdout.trim();
  if (!version) {
    return null;
  }

  const executableDir = path.dirname(executable);
  const baseDir = isWindows ? executableDir : path.resolve(executableDir, "..");
  const binDir = isWindows ? baseDir : path.join(baseDir, "bin");

  return {
    command: executable,
    version,
    baseDir,
    binDir,
    npmPath: isWindows ? path.join(baseDir, "npm.cmd") : path.join(binDir, "npm"),
  };
}

function withRuntimePath(env, nodeRuntime) {
  const key = isWindows ? "Path" : "PATH";
  const existingPath = env[key] || env.PATH || process.env[key] || process.env.PATH || "";
  return {
    ...env,
    [key]: [nodeRuntime.binDir, existingPath].filter(Boolean).join(path.delimiter),
  };
}

export function resolveNodeRuntime(runtimeEnv = process.env, minimumVersion = "20.0.0") {
  const candidates = [
    runtimeEnv.LEARNING_LOOP_NODE,
    localNodeRuntimeDir,
    process.execPath,
  ];

  const inspectedRuntimes = candidates
    .map(resolveNodeExecutable)
    .filter(Boolean)
    .map(inspectNodeRuntime)
    .filter(Boolean);

  const supportedRuntime = inspectedRuntimes.find((runtime) => compareVersions(runtime.version, minimumVersion) >= 0);
  if (supportedRuntime) {
    return supportedRuntime;
  }

  const discoveredVersions = inspectedRuntimes
    .map((runtime) => `${runtime.command} (${runtime.version})`)
    .join(", ");

  throw new Error(
    `Node.js ${minimumVersion}+ is required. Available runtimes: ${discoveredVersions || "none"}. ` +
      "Install Node 20+, set LEARNING_LOOP_NODE, or place a runtime under .tools/node-runtime."
  );
}

export function resolvePythonCommand(runtimeEnv = process.env) {
  const candidates = isWindows
    ? [
        runtimeEnv.PYTHON_EXECUTABLE,
        runtimeEnv.PYTHON,
        "python",
        "python3",
      ]
    : [
        runtimeEnv.PYTHON_EXECUTABLE,
        runtimeEnv.PYTHON,
        "python3",
        "python",
      ];

  for (const candidate of candidates.filter(Boolean)) {
    if (commandWorks(candidate, ["--version"])) {
      return {
        command: candidate,
        prefixArgs: [],
      };
    }
  }

  throw new Error("Python 3.11+ is required but no working python command was found.");
}

export function ensureRuntimeDirs() {
  mkdirSync(logDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  mkdirSync(localLivekitRuntimeDir, { recursive: true });
}

export function pidFileFor(name) {
  return path.join(pidDir, `${name}.pid`);
}

export function logFileFor(name) {
  return path.join(logDir, `${name}.log`);
}

function livekitArchiveExtension() {
  if (isWindows) {
    return "zip";
  }
  return "tar.gz";
}

function livekitAssetNameForPlatform(tagName) {
  if (process.platform === "win32" && process.arch === "x64") {
    return `livekit_${tagName.replace(/^v/u, "")}_windows_amd64.zip`;
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return `livekit_${tagName.replace(/^v/u, "")}_windows_arm64.zip`;
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return `livekit_${tagName.replace(/^v/u, "")}_linux_amd64.tar.gz`;
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return `livekit_${tagName.replace(/^v/u, "")}_linux_arm64.tar.gz`;
  }
  if (process.platform === "linux" && process.arch === "arm") {
    return `livekit_${tagName.replace(/^v/u, "")}_linux_armv7.tar.gz`;
  }
  return null;
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function findFileRecursive(baseDir, fileName) {
  if (!existsSync(baseDir)) {
    return null;
  }

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const entryPath = path.join(baseDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nested = findFileRecursive(entryPath, fileName);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `${formatCommand(command, args)} terminated with signal ${signal}.`
            : `${formatCommand(command, args)} exited with code ${code ?? "unknown"}.`
        )
      );
    });
  });
}

async function downloadToFile(url, destinationPath) {
  if (isWindows) {
    await runCommand("powershell", [
      "-NoProfile",
      "-Command",
      `Invoke-WebRequest -UseBasicParsing -Uri ${powershellLiteral(url)} -OutFile ${powershellLiteral(destinationPath)}`,
    ]);
    return;
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "learning-loop-ai-dev-runtime",
      accept: "application/octet-stream,application/json;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  writeFileSync(destinationPath, Buffer.from(arrayBuffer));
}

async function extractLivekitArchive(archivePath, destinationDir) {
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });

  if (isWindows) {
    await runCommand("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${powershellLiteral(archivePath)} -DestinationPath ${powershellLiteral(destinationDir)} -Force`,
    ]);
    return;
  }

  await runCommand("tar", ["-xzf", archivePath, "-C", destinationDir]);
}

async function fetchLatestLivekitRelease() {
  const response = await fetch("https://api.github.com/repos/livekit/livekit/releases/latest", {
    headers: {
      "user-agent": "learning-loop-ai-dev-runtime",
      accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch latest LiveKit release metadata: HTTP ${response.status}.`);
  }

  return response.json();
}

export async function ensureLocalLivekitServerBinary() {
  ensureRuntimeDirs();

  if (commandWorks("livekit-server", ["--version"])) {
    return "livekit-server";
  }

  const binaryName = isWindows ? "livekit-server.exe" : "livekit-server";
  const currentBinary = findFileRecursive(localLivekitRuntimeDir, binaryName);
  if (currentBinary && statSync(currentBinary).isFile()) {
    return currentBinary;
  }

  const release = await fetchLatestLivekitRelease();
  const assetName = livekitAssetNameForPlatform(release.tag_name);
  if (!assetName) {
    throw new Error(
      `Automatic local LiveKit setup is not implemented for ${process.platform}/${process.arch}. ` +
        "Configure LIVEKIT_URL/LIVEKIT_WS_URL manually."
    );
  }

  const asset = (release.assets || []).find((item) => item.name === assetName);
  if (!asset?.browser_download_url) {
    throw new Error(`LiveKit release ${release.tag_name} does not include asset ${assetName}.`);
  }

  const downloadsDir = path.join(localLivekitRuntimeDir, "downloads");
  const versionDir = path.join(localLivekitRuntimeDir, release.tag_name);
  const archivePath = path.join(downloadsDir, assetName);
  mkdirSync(downloadsDir, { recursive: true });

  if (!existsSync(archivePath)) {
    console.log(`Downloading LiveKit server ${release.tag_name}...`);
    await downloadToFile(asset.browser_download_url, archivePath);
  }

  console.log(`Extracting LiveKit server ${release.tag_name}...`);
  await extractLivekitArchive(archivePath, versionDir);

  const extractedBinary = findFileRecursive(versionDir, binaryName);
  if (!extractedBinary) {
    throw new Error(`LiveKit archive ${assetName} did not contain ${binaryName}.`);
  }

  if (!isWindows) {
    await runCommand("chmod", ["+x", extractedBinary]);
  }

  return extractedBinary;
}

export async function resolveLivekitRuntime(runtimeEnv = process.env) {
  const wsUrl = runtimeEnv.LIVEKIT_WS_URL || runtimeEnv.LIVEKIT_URL || "";
  const apiKey = runtimeEnv.LIVEKIT_API_KEY || "";
  const apiSecret = runtimeEnv.LIVEKIT_API_SECRET || "";

  if (wsUrl && apiKey && apiSecret) {
    return {
      mode: "configured",
      managed: false,
      env: runtimeEnv,
      wsUrl,
    };
  }

  const binary = await ensureLocalLivekitServerBinary();
  return {
    mode: "local-dev",
    managed: true,
    binary,
    port: localLivekitPort,
    wsUrl: localLivekitWsUrl,
    httpUrl: localLivekitHttpUrl,
    env: {
      ...runtimeEnv,
      LIVEKIT_URL: runtimeEnv.LIVEKIT_URL || localLivekitWsUrl,
      LIVEKIT_WS_URL: runtimeEnv.LIVEKIT_WS_URL || localLivekitWsUrl,
      LIVEKIT_API_HOST: runtimeEnv.LIVEKIT_API_HOST || localLivekitHttpUrl,
      LIVEKIT_API_KEY: runtimeEnv.LIVEKIT_API_KEY || localLivekitApiKey,
      LIVEKIT_API_SECRET: runtimeEnv.LIVEKIT_API_SECRET || localLivekitApiSecret,
    },
  };
}

export function runNodeCommand(nodeRuntime, args, options = {}) {
  return runCommand(nodeRuntime.command, args, {
    ...options,
    env: withRuntimePath(options.env || process.env, nodeRuntime),
  });
}

export function runNpmCommand(nodeRuntime, args, options = {}) {
  const npmEntry = existsSync(nodeRuntime.npmPath) ? nodeRuntime.npmPath : npmCommand;
  return runCommand(npmEntry, args, {
    ...options,
    shell: isWindows,
    env: withRuntimePath(options.env || process.env, nodeRuntime),
  });
}

function runPythonSync(pythonSpec, args) {
  return spawnSyncQuiet(pythonSpec.command, [...pythonSpec.prefixArgs, ...args]);
}

async function ensureNodePackageDependencies(packageDir, label, runtimeEnv, nodeRuntime) {
  if (existsSync(path.join(packageDir, "node_modules"))) {
    return;
  }

  const packageJsonPath = path.join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const hasDependencies =
    Object.keys(packageJson.dependencies || {}).length > 0 ||
    Object.keys(packageJson.devDependencies || {}).length > 0 ||
    existsSync(path.join(packageDir, "package-lock.json"));

  if (!hasDependencies) {
    return;
  }

  console.log(`Installing ${label} dependencies...`);
  await runNpmCommand(nodeRuntime, ["install"], {
    cwd: packageDir,
    env: runtimeEnv,
  });
}

export async function ensureFrontendDependencies(runtimeEnv, nodeRuntime) {
  await ensureNodePackageDependencies(frontendDir, "frontend", runtimeEnv, nodeRuntime);
}

export async function ensureLivekitAgentDependencies(runtimeEnv, nodeRuntime) {
  await ensureNodePackageDependencies(livekitAgentDir, "livekit-agent", runtimeEnv, nodeRuntime);
}

export async function ensureLivekitAgentModelFiles(runtimeEnv, nodeRuntime) {
  const packageLockPath = path.join(livekitAgentDir, "package-lock.json");
  const markerPath = path.join(localLivekitRuntimeDir, "livekit-agent-models.ready.json");
  const signatureParts = ["livekit-agent-models-v1"];

  if (existsSync(packageLockPath)) {
    const packageLockStats = statSync(packageLockPath);
    signatureParts.push(String(packageLockStats.size), String(packageLockStats.mtimeMs));
  }

  const signature = signatureParts.join(":");

  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (marker.signature === signature) {
        return;
      }
    } catch {}
  }

  console.log("Downloading LiveKit agent model files...");
  await runNodeCommand(nodeRuntime, [path.join(livekitAgentDir, "src", "worker.js"), "download-files"], {
    cwd: rootDir,
    env: runtimeEnv,
  });

  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        signature,
        completedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
}

export async function ensurePythonDependencies(runtimeEnv) {
  const pythonSpec = resolvePythonCommand(runtimeEnv);
  const importCheck = runPythonSync(pythonSpec, ["-c", "import fastapi, uvicorn"]);
  if (importCheck.status === 0) {
    return pythonSpec;
  }

  console.log("Installing Python dependencies for ai-service...");
  const installBaseArgs = [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "-r",
    path.join(aiServiceDir, "requirements.txt"),
  ];

  const installWithoutUser = spawnSyncQuiet(pythonSpec.command, [...pythonSpec.prefixArgs, ...installBaseArgs]);
  if (installWithoutUser.status === 0) {
    return pythonSpec;
  }

  await runCommand(pythonSpec.command, [...pythonSpec.prefixArgs, ...installBaseArgs, "--user"], {
    env: runtimeEnv,
    cwd: rootDir,
  });
  return pythonSpec;
}

export async function buildFrontend(runtimeEnv, bffPort, livekitAgentPort, nodeRuntime) {
  console.log("Building frontend production bundle...");
  await runNpmCommand(nodeRuntime, ["run", "build"], {
    cwd: frontendDir,
    env: {
      ...runtimeEnv,
      NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${bffPort}`,
      NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL: `http://127.0.0.1:${livekitAgentPort}`,
    },
  });
}

export function spawnDetachedProcess({ name, command, args, cwd, env }) {
  const logFile = logFileFor(name);
  const logFd = openSync(logFile, "a");

  try {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });

    writeFileSync(pidFileFor(name), `${child.pid}\n`, "utf8");
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

export function readTrackedPids() {
  return trackedServices.flatMap((name) => {
    const pidFile = pidFileFor(name);
    if (!existsSync(pidFile)) {
      return [];
    }

    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? [{ name, pid }] : [];
  });
}

export function removePidFile(name) {
  rmSync(pidFileFor(name), { force: true });
}

export function killProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (isWindows) {
    spawnSyncQuiet("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

export function stopTrackedServices({ silent = false } = {}) {
  const stopped = [];
  for (const { name, pid } of readTrackedPids()) {
    killProcess(pid);
    removePidFile(name);
    stopped.push({ name, pid });
    if (!silent) {
      console.log(`Stopped PID ${pid} from ${path.basename(pidFileFor(name))}`);
    }
  }
  return stopped;
}

export function cleanupStartedServices(services) {
  for (const { name, pid } of services) {
    killProcess(pid);
    removePidFile(name);
  }
}

export function findListeningPids(port) {
  if (!Number.isInteger(port) || port <= 0) {
    return [];
  }

  if (isWindows) {
    const result = spawnSyncQuiet("netstat", ["-ano", "-p", "tcp"]);
    if (result.status !== 0) {
      return [];
    }

    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0].toUpperCase() !== "TCP" || parts[3].toUpperCase() !== "LISTENING") {
        continue;
      }

      const localAddress = parts[1];
      const localPort = Number.parseInt(localAddress.slice(localAddress.lastIndexOf(":") + 1), 10);
      if (localPort !== port) {
        continue;
      }

      const pid = Number.parseInt(parts[4], 10);
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
    return [...pids];
  }

  const result = spawnSyncQuiet("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"]);
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function waitForListeningPort(name, port, attempts = 60) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (findListeningPids(port).length) {
      console.log(`${name} is listening on port ${port}`);
      return;
    }
    await sleep(1_000);
  }

  throw new Error(`${name} failed to open port ${port}.`);
}

export function assertPortsAvailable(portEntries) {
  const conflicts = portEntries.flatMap(([serviceName, port]) => {
    const pids = findListeningPids(port);
    return pids.length ? [{ serviceName, port, pids }] : [];
  });

  if (!conflicts.length) {
    return;
  }

  const details = conflicts
    .map(({ serviceName, port, pids }) => `${serviceName} port ${port} is already in use by PID ${pids.join(", ")}`)
    .join("; ");

  throw new Error(
    `${details}. Stop the existing process or override FRONTEND_PORT/BFF_PORT/SUPERAPP_PORT/LIVEKIT_AGENT_PORT/AI_PORT.`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOk(url, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const request = transport.request(
      parsedUrl,
      {
        method: "GET",
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        resolve((response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300);
      }
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });

    request.on("error", () => {
      resolve(false);
    });

    request.end();
  });
}

export async function waitForHealth(name, url, attempts = 60) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await requestOk(url)) {
      console.log(`${name} is ready: ${url}`);
      return;
    }

    await sleep(1_000);
  }

  throw new Error(`${name} failed health check: ${url}`);
}
