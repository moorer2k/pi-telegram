/**
 * Opt-in self-update for a locally managed Pi Telegram checkout.
 * No shell, user-supplied commands, or implicit restart authority.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

function run(command: string, args: string[], cwd: string, timeoutMs = 120000): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-4000); });
    child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-4000); });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => {
      clearTimeout(timeout);
      code === 0 ? resolveResult(output.trim()) : reject(new Error(command + " exited " + code + ": " + output.slice(-1200)));
    });
  });
}

let updating = false;

/**
 * Explicit configuration:
 * PI_TELEGRAM_UPDATE_DIR: absolute checkout directory
 * PI_TELEGRAM_UPDATE_BRANCH: branch to fast-forward (defaults to main)
 * PI_TELEGRAM_RESTART_UNIT: allowlisted systemd user service
 */
export async function updateTelegramCheckout(): Promise<string> {
  if (updating) throw new Error("Update already running");
  const directory = process.env.PI_TELEGRAM_UPDATE_DIR;
  const unit = process.env.PI_TELEGRAM_RESTART_UNIT;
  const branch = process.env.PI_TELEGRAM_UPDATE_BRANCH ?? "main";
  if (!directory?.startsWith("/") || resolve(directory) !== directory)
    throw new Error("Set PI_TELEGRAM_UPDATE_DIR to an absolute checkout path");
  if (!unit || !/^[a-zA-Z0-9_.@-]+\\.service$/.test(unit))
    throw new Error("Set PI_TELEGRAM_RESTART_UNIT to a systemd user service");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes(".."))
    throw new Error("Invalid update branch");
  updating = true;
  try {
    const inside = await run("git", ["rev-parse", "--show-toplevel"], directory);
    if (resolve(inside) !== directory) throw new Error("Update directory must be the Git checkout root");
    const current = await run("git", ["branch", "--show-current"], directory);
    if (current !== branch) throw new Error("Checkout is on " + current + ", expected " + branch);
    const dirty = await run("git", ["status", "--porcelain"], directory);
    if (dirty) throw new Error("Checkout contains local changes; update refused");
    await run("git", ["fetch", "--prune", "origin", branch], directory);
    await run("git", ["merge", "--ff-only", "FETCH_HEAD"], directory);
    await run("npm", ["ci", "--ignore-scripts"], directory, 180000);
    await run("npm", ["run", "build"], directory, 180000);
    await run("npm", ["run", "typecheck"], directory, 180000);
    // Restart after the Telegram callback has had time to publish its success message.
    setTimeout(() => {
      const child = spawn("systemctl", ["--user", "restart", unit], {
        cwd: directory, detached: true, stdio: "ignore", shell: false,
      });
      child.on("error", () => {});
      child.unref();
    }, 2000);
    return "Updated " + branch + "; build and typecheck passed. Restart scheduled.";
  } finally {
    updating = false;
  }
}
