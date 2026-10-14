// Runs automatically before `npm run dev` (see package.json's "predev").
// Kills whatever's already listening on PORT, so a leftover/orphaned server
// process from a previous run never blocks the next `npm run dev` with
// EADDRINUSE again.
require("dotenv/config");
const { execSync } = require("node:child_process");

const port = process.env.PORT || 4001;

try {
  if (process.platform === "win32") {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split("\n")) {
      const match = line.trim().match(/LISTENING\s+(\d+)\s*$/);
      if (match) pids.add(match[1]);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`[free-port] Freed port ${port} (killed PID ${pid})`);
      } catch {
        // already gone — fine
      }
    }
  } else {
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").filter(Boolean)) {
      try {
        execSync(`kill -9 ${pid}`, { stdio: "ignore" });
        console.log(`[free-port] Freed port ${port} (killed PID ${pid})`);
      } catch {
        // already gone — fine
      }
    }
  }
} catch {
  // Nothing was listening on the port — nothing to free.
}
