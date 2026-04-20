#!/usr/bin/env node

import path from "node:path";
import {
  aiServiceDir,
  assertPortsAvailable,
  buildFrontend,
  cleanupStartedServices,
  ensureFrontendDependencies,
  ensureLivekitAgentDependencies,
  ensureLivekitAgentModelFiles,
  ensurePythonDependencies,
  ensureRuntimeDirs,
  findListeningPids,
  frontendDir,
  livekitAgentDir,
  loadRuntimeEnv,
  logDir,
  pidDir,
  resolveLivekitRuntime,
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
  const livekitAgentPort = parsePort("LIVEKIT_AGENT_PORT", runtimeEnv.LIVEKIT_AGENT_PORT, 4200);
  const aiPort = parsePort("AI_PORT", runtimeEnv.AI_PORT, 8000);
  const nodeRuntime = resolveNodeRuntime(runtimeEnv);
  const livekitRuntime = await resolveLivekitRuntime(runtimeEnv);

  stopTrackedServices({ silent: true });
  assertPortsAvailable([
    ["frontend", frontendPort],
    ["bff", bffPort],
    ["superapp-service", superappPort],
    ["livekit-agent", livekitAgentPort],
    ["ai-service", aiPort],
  ]);

  const serviceEnv = livekitRuntime.env;
  const pythonSpec = await ensurePythonDependencies(serviceEnv);
  console.log(`Using Node.js ${nodeRuntime.version} from ${nodeRuntime.command}`);
  if (livekitRuntime.mode === "local-dev") {
    console.log(`Using auto-managed local LiveKit at ${livekitRuntime.wsUrl}`);
  }
  await ensureFrontendDependencies(serviceEnv, nodeRuntime);
  await ensureLivekitAgentDependencies(serviceEnv, nodeRuntime);
  await ensureLivekitAgentModelFiles(serviceEnv, nodeRuntime);
  await buildFrontend(serviceEnv, bffPort, livekitAgentPort, nodeRuntime);

  const startedServices = [];

  try {
    if (livekitRuntime.managed) {
      const livekitAlreadyRunning = findListeningPids(livekitRuntime.port).length > 0;
      if (livekitAlreadyRunning) {
        console.log(`Reusing existing local LiveKit server on port ${livekitRuntime.port}...`);
      } else {
        console.log("Starting local LiveKit server...");
        startedServices.push({
          name: "livekit-server",
          pid: spawnDetachedProcess({
            name: "livekit-server",
            command: livekitRuntime.binary,
            args: [
              "--dev",
              "--bind",
              "127.0.0.1",
              "--node-ip",
              "127.0.0.1",
              "--rtc.node_ip.ipv4",
              "127.0.0.1",
              "--keys",
              "devkey: secret",
            ],
            cwd: rootDir,
            env: serviceEnv,
          }),
        });
      }
      await waitForListeningPort("LiveKit server", livekitRuntime.port);
    }

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

    console.log("Starting LiveKit agent bridge...");
    startedServices.push({
      name: "livekit-agent",
      pid: spawnDetachedProcess({
        name: "livekit-agent",
        command: nodeRuntime.command,
        args: [path.join(livekitAgentDir, "src", "index.js")],
        cwd: livekitAgentDir,
        env: {
          ...serviceEnv,
          PORT: String(livekitAgentPort),
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
          NEXT_PUBLIC_INTERVIEW_ASSIST_API_BASE_URL: `http://127.0.0.1:${livekitAgentPort}`,
        },
      }),
    });

    await waitForHealth("AI service", `http://127.0.0.1:${aiPort}/api/health`);
    await waitForHealth("BFF", `http://127.0.0.1:${bffPort}/api/health`);
    await waitForHealth("Superapp service", `http://127.0.0.1:${superappPort}/api/health`);
    await waitForHealth("LiveKit agent bridge", `http://127.0.0.1:${livekitAgentPort}/api/health`);
    await waitForHealth("Frontend", `http://127.0.0.1:${frontendPort}`);

    console.log("");
    console.log("Learning Loop AI split services are running.");
    console.log("");
    console.log(`- Frontend: http://127.0.0.1:${frontendPort}`);
    console.log(`- BFF: http://127.0.0.1:${bffPort}`);
    console.log(`- Superapp service: http://127.0.0.1:${superappPort}`);
    console.log(`- LiveKit agent bridge: http://127.0.0.1:${livekitAgentPort}`);
    console.log(`- AI service: http://127.0.0.1:${aiPort}`);
    if (livekitRuntime.managed) {
      console.log(`- LiveKit server: ${livekitRuntime.wsUrl}`);
    }
    console.log("");
    console.log("Logs:");
    console.log(`- ${path.join(logDir, "frontend.log")}`);
    console.log(`- ${path.join(logDir, "bff.log")}`);
    console.log(`- ${path.join(logDir, "superapp-service.log")}`);
    console.log(`- ${path.join(logDir, "livekit-agent.log")}`);
    console.log(`- ${path.join(logDir, "ai-service.log")}`);
    if (livekitRuntime.managed) {
      console.log(`- ${path.join(logDir, "livekit-server.log")}`);
    }
    console.log("");
    console.log("PID files:");
    console.log(`- ${path.join(pidDir, "frontend.pid")}`);
    console.log(`- ${path.join(pidDir, "bff.pid")}`);
    console.log(`- ${path.join(pidDir, "superapp-service.pid")}`);
    console.log(`- ${path.join(pidDir, "livekit-agent.pid")}`);
    console.log(`- ${path.join(pidDir, "ai-service.pid")}`);
    if (livekitRuntime.managed) {
      console.log(`- ${path.join(pidDir, "livekit-server.pid")}`);
    }
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
