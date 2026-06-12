import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";

const processes = [
  {
    name: "server",
    args: ["run", "dev", "--prefix", "server"],
  },
  {
    name: "client",
    args: ["run", "dev", "--prefix", "client"],
  },
].map(({ name, args }) => {
  const child = spawn(npmCommand, args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (shutdown.started) {
      return;
    }

    shutdown.started = true;
    shutdown.code = code ?? (signal ? 1 : 0);
    shutdown();
  });

  child.on("error", (error) => {
    console.error(`[${name}] failed to start:`, error.message);
    if (!shutdown.started) {
      shutdown.started = true;
      shutdown.code = 1;
      shutdown();
    }
  });

  return { name, child };
});

const shutdown = Object.assign(
  () => {
    for (const { child } of processes) {
      if (!child.killed) {
        child.kill();
      }
    }

    setTimeout(() => process.exit(shutdown.code ?? 0), 250).unref();
  },
  { started: false, code: 0 }
);

process.on("SIGINT", () => {
  if (!shutdown.started) {
    shutdown.started = true;
  }
  shutdown.code = 130;
  shutdown();
});

process.on("SIGTERM", () => {
  if (!shutdown.started) {
    shutdown.started = true;
  }
  shutdown.code = 143;
  shutdown();
});
