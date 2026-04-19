import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const children = [];
let shuttingDown = false;

function startChild(scriptName, required = false) {
  if (
    scriptName === "worker.js" &&
    !(process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL) &&
    !required
  ) {
    console.warn("LiveKit worker not started: LIVEKIT_URL/LIVEKIT_WS_URL is missing.");
    return null;
  }

  const args = [path.join(root, scriptName)];
  if (scriptName === "worker.js") {
    args.push("start");
  }

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const other of children) {
      if (other.pid && other.pid !== child.pid) {
        other.kill("SIGTERM");
      }
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
  return child;
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startChild("server.js", true);
startChild("worker.js");
