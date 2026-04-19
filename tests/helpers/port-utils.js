import { execSync } from "node:child_process";

export function killExistingOnPort(port) {
  try {
    const output = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (!output) {
      return;
    }
    for (const pid of output.split(/\s+/).filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {}
    }
  } catch {}
}
