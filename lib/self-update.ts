/**
 * Telegram extension updater using the existing Pi-Bolt systemd restart configuration.
 * Mirrors VENOM maintenance: installed checkout, clean tree, fast-forward, configured scope.
 * Zones: telegram, pi agent
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ORIGIN = /^(?:https:\/\/github\.com\/moorer2k\/pi-telegram(?:\.git)?|git@github\.com:moorer2k\/pi-telegram(?:\.git)?)$/i;
const UNIT_RE = /^[a-zA-Z0-9_.@-]+\.service$/;
let updating = false;

function run(command: string, args: string[], cwd: string, timeoutMs = 120000): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let finished = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) fail(error);
      else done(output.trim());
    };
    child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-4096); });
    child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-4096); });
    child.on("error", error => finish(error));
    child.on("close", code => finish(code === 0 ? undefined : new Error(command + " exited " + code + ": " + output.slice(-1000))));
  });
}

export async function updateTelegramCheckout(): Promise<string> {
  if (updating) throw new Error("Update already running");
  const unit = process.env.PI_TELEGRAM_RESTART_UNIT?.trim();
  const scope = process.env.PI_TELEGRAM_RESTART_SCOPE === "system" ? "--system" : "--user";
  if (!unit || !UNIT_RE.test(unit)) throw new Error("PI_TELEGRAM_RESTART_UNIT is not configured");
  updating = true;
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const top = await run("git", ["rev-parse", "--show-toplevel"], root);
    if (resolve(top) !== root) throw new Error("Installed extension must be at its Git checkout root");
    const origin = await run("git", ["remote", "get-url", "origin"], root);
    if (!EXPECTED_ORIGIN.test(origin)) throw new Error("Unexpected Git origin");
    const branch = await run("git", ["branch", "--show-current"], root);
    if (branch !== "main") throw new Error("Checkout must be on main");
    if (await run("git", ["status", "--porcelain"], root)) throw new Error("Checkout has local changes");
    const active = await run("systemctl", [scope, "is-active", unit], root);
    if (active !== "active") throw new Error("Configured Pi-Bolt service is not active");
    await run("git", ["fetch", "--no-tags", "origin", "main"], root);
    await run("git", ["merge", "--ff-only", "FETCH_HEAD"], root);
    await run("npm", ["ci", "--ignore-scripts"], root, 180000);
    await run("npm", ["run", "build"], root, 180000);
    await run("npm", ["run", "typecheck"], root, 180000);
    const sha = await run("git", ["rev-parse", "--short", "HEAD"], root);
    setTimeout(() => {
      const child = spawn("systemctl", [scope, "restart", unit], { detached: true, stdio: "ignore", shell: false });
      child.on("error", () => {});
      child.unref();
    }, 3000);
    return "Updated to " + sha + ". Build and typecheck passed; restarting Pi-Bolt.";
  } finally {
    updating = false;
  }
}
