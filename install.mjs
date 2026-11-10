#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const mods = ["glass-shell", "shell-spaces", "shell-agents", "shell-pane", "shell-files", "shell-changes", "shell-issues", "shell-new-menu", "insights"];
const section = "layout:glass-workspace";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("node install.mjs [--no-switch]\nInstalls into HERDR_APP_HOME, XDG_CONFIG_HOME/herdr-app, or ~/.config/herdr-app. Existing layout/mod names are refused.");
  process.exit(0);
}
if (args.some(arg => arg !== "--no-switch")) throw new Error("Unknown option; run node install.mjs --help.");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Use Node.js 24 or later.");

const home = path.resolve(process.env.HERDR_APP_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr-app"));
const env = { ...process.env, HERDR_APP_HOME: home };
const candidates = [
  process.platform === "win32" ? "herdr-app.exe" : "herdr-app",
  path.join(os.homedir(), ".local", "bin", "herdr-app"),
  ...(process.platform === "darwin" ? ["/Applications/Herdr.app/Contents/MacOS/Herdr", path.join(os.homedir(), "Applications/Herdr.app/Contents/MacOS/Herdr")] : []),
  ...(process.platform === "win32" && process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs", "herdr-app", "herdr-app.exe")] : []),
];
const cli = candidates.find(candidate => spawnSync(candidate, ["--version"], { env, encoding: "utf8", timeout: 10000, windowsHide: true }).status === 0);
if (!cli) throw new Error("Install Herdr first: https://herdr.dev/download/");

const exists = file => {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
for (const name of ["layouts/glass-workspace.json", "layouts/glass-workspace.svg", "themes/neutral-charcoal.json", ...mods.map(name => `mods/${name}`)]) {
  if (exists(path.join(home, name))) throw new Error(`Already exists: ${name}. Ask your agent to compare and rename or update it; this installer never overwrites an existing layout or mod.`);
}
const keysPath = path.join(home, "keys.json");
if (exists(keysPath) && fs.lstatSync(keysPath).isSymbolicLink()) throw new Error("keys.json is a symbolic link; ask your agent to merge the layout shortcuts manually.");
const originalKeys = exists(keysPath) ? fs.readFileSync(keysPath, "utf8") : null;
const keys = originalKeys === null ? {} : JSON.parse(originalKeys.replace(/^\uFEFF/, ""));
if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error("Existing keys.json must be a JSON object.");
if (section in keys) throw new Error("Glass Workspace shortcuts already exist; ask your agent to compare them before updating.");
const keyFile = process.platform === "darwin" ? "keys.macos.json" : "keys.json";
keys[section] = JSON.parse(fs.readFileSync(path.join(root, keyFile), "utf8"))[section];

const files = [];
function collect(relative) {
  const source = path.join(root, relative);
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`Unexpected source link: ${relative}`);
  if (info.isDirectory()) {
    for (const name of fs.readdirSync(source)) collect(path.join(relative, name));
  } else if (info.isFile()) {
    if (exists(path.join(home, relative))) throw new Error(`Already exists: ${relative}`);
    const content = relative.replaceAll(path.sep, "/") === "mods/insights/runtime.json"
      ? Buffer.from(JSON.stringify({ node: process.execPath }) + "\n")
      : fs.readFileSync(source);
    files.push({ relative, content });
  }
}
for (const name of ["layouts/glass-workspace.json", "layouts/glass-workspace.svg", "themes/neutral-charcoal.json", ...mods.map(name => `mods/${name}`)]) collect(name);

for (const { relative, content } of files) {
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { flag: "wx" });
}
const currentKeys = exists(keysPath) ? fs.readFileSync(keysPath, "utf8") : null;
if (currentKeys !== originalKeys) throw new Error("keys.json changed during installation. The layout files are installed; ask your agent to merge its shortcuts.");
const temporaryKeys = path.join(home, `.keys-glass-workspace-${process.pid}.tmp`);
try {
  fs.writeFileSync(temporaryKeys, JSON.stringify(keys, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(temporaryKeys, keysPath);
} finally {
  if (exists(temporaryKeys)) fs.unlinkSync(temporaryKeys);
}

for (const mod of mods) {
  const result = spawnSync(cli, ["check", path.join(home, "mods", mod)], { env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Herdr could not load ${mod}. Inspect the error above before switching layouts.`);
}
console.log(`Installed Glass Workspace and ${mods.length} mods into ${home}.`);
if (!args.includes("--no-switch")) {
  const result = spawnSync(cli, ["do", "layout.switch", "--name", "glass-workspace"], { env, encoding: "utf8", windowsHide: true });
  if (result.status === 0) console.log("Switched to Glass Workspace.");
  else console.log("Open Herdr and choose 炭灰工作台, or run: herdr-app do layout.switch --name glass-workspace");
}
