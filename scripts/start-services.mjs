#!/usr/bin/env node

import path from "node:path";
import {
  aiServiceDir,
  assertPortsAvailable,
  buildFrontend,
  cleanupStartedServices,
  ensureFrontendDependencies,
  ensurePythonDependencies,
  ensureRuntimeDirs,
  frontendDir,
  loadRuntimeEnv,
  logDir,
  pidDir,
  resolveNodeRuntime,
  rootDir,
  spawnDetachedProcess,
  superappServiceDir,
  stopTrackedServices,
  waitForHealth,
  waitForListeningPort,
} from "./service-runtime.mjs";

function parsePort(name, value, fallback) {
  const port = Number.parseInt(value || "", 10);
  if (Number.isInteger(port) && port > 0) {
    return port;
  }
  return fallback;
}

async function main() {
  ensureRuntimeDirs();

  const runtimeEnv = loadRuntimeEnv();
  const frontendPort = parsePort("FRONTEND_PORT", runtimeEnv.FRONTEND_PORT, 3000);
  const bffPort = parsePort("BFF_PORT", runtimeEnv.BFF_PORT, 4000);
  const superappPort = parsePort("SUPERAPP_PORT", runtimeEnv.SUPERAPP_PORT, 4100);
  const aiPort = parsePort("AI_PORT", runtimeEnv.AI_PORT, 8000);
  const nodeRuntime = resolveNodeRuntime(runtimeEnv);

  stopTrackedServices({ silent: true });
  assertPortsAvailable([
    ["frontend", frontendPort],
    ["bff", bffPort],
    ["superapp-service", superappPort],
    ["ai-service", aiPort],
  ]);

  const serviceEnv = runtimeEnv;
  const pythonSpec = await ensurePythonDependencies(serviceEnv);
  console.log(`Using Node.js ${nodeRuntime.version} from ${nodeRuntime.command}`);
  await ensureFrontendDependencies(serviceEnv, nodeRuntime);
  await buildFrontend(serviceEnv, bffPort, aiPort, nodeRuntime);

  const startedServices = [];

  try {
    console.log("Starting AI service...");
    startedServices.push({
      name: "ai-service",
      pid: spawnDetachedProcess({
        name: "ai-service",
        command: pythonSpec.command,
        args: [
          ...pythonSpec.prefixArgs,
          "-m",
          "uvicorn",
          "app.main:app",
          "--host",
          "127.0.0.1",
          "--port",
          String(aiPort),
          "--app-dir",
          aiServiceDir,
        ],
        cwd: rootDir,
        env: serviceEnv,
      }),
    });

    console.log("Starting BFF...");
    startedServices.push({
      name: "bff",
      pid: spawnDetachedProcess({
        name: "bff",
        command: nodeRuntime.command,
        args: [path.join(rootDir, "bff", "src", "server.js")],
        cwd: rootDir,
        env: {
          ...serviceEnv,
          PORT: String(bffPort),
          AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`,
        },
      }),
    });

    console.log("Starting superapp service...");
    startedServices.push({
      name: "superapp-service",
      pid: spawnDetachedProcess({
        name: "superapp-service",
        command: nodeRuntime.command,
        args: [path.join(superappServiceDir, "src", "server.js")],
        cwd: superappServiceDir,
        env: {
          ...serviceEnv,
          PORT: String(superappPort),
          BFF_URL: `http://127.0.0.1:${bffPort}`,
          AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`,
        },
      }),
    });

    console.log("Starting frontend...");
    startedServices.push({
      name: "frontend",
      pid: spawnDetachedProcess({
        name: "frontend",
        command: nodeRuntime.command,
        args: [
          path.join(frontendDir, "node_modules", "next", "dist", "bin", "next"),
          "start",
          "-p",
          String(frontendPort),
        ],
        cwd: frontendDir,
        env: {
          ...serviceEnv,
          PORT: String(frontendPort),
          NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${bffPort}`,
          NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL: `http://127.0.0.1:${aiPort}`,
        },
      }),
    });

    await waitForHealth("AI service", `http://127.0.0.1:${aiPort}/api/health`);
    await waitForHealth("BFF", `http://127.0.0.1:${bffPort}/api/health`);
    await waitForHealth("Superapp service", `http://127.0.0.1:${superappPort}/api/health`);
    await waitForHealth("Frontend", `http://127.0.0.1:${frontendPort}`);

    console.log("");
    console.log("Learning Loop AI split services are running.");
    console.log("");
    console.log(`- Frontend: http://127.0.0.1:${frontendPort}`);
    console.log(`- BFF: http://127.0.0.1:${bffPort}`);
    console.log(`- Superapp service: http://127.0.0.1:${superappPort}`);
    console.log(`- AI service: http://127.0.0.1:${aiPort}`);
    console.log("");
    console.log("Logs:");
    console.log(`- ${path.join(logDir, "frontend.log")}`);
    console.log(`- ${path.join(logDir, "bff.log")}`);
    console.log(`- ${path.join(logDir, "superapp-service.log")}`);
    console.log(`- ${path.join(logDir, "ai-service.log")}`);
    console.log("");
    console.log("PID files:");
    console.log(`- ${path.join(pidDir, "frontend.pid")}`);
    console.log(`- ${path.join(pidDir, "bff.pid")}`);
    console.log(`- ${path.join(pidDir, "superapp-service.pid")}`);
    console.log(`- ${path.join(pidDir, "ai-service.pid")}`);
    console.log("");
    console.log("To stop all services:");
    console.log("  npm run stop");
  } catch (error) {
    cleanupStartedServices(startedServices);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
