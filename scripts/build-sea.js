const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const kok = join(__dirname, "..");
const dist = join(kok, "dist");
const exe = join(dist, "VegaRaporlama.exe");
const blob = join(dist, "sea-prep.blob");
const config = join(kok, "sea-config.json");

mkdirSync(dist, { recursive: true });
copyFileSync(process.execPath, exe);
execFileSync(process.execPath, ["--experimental-sea-config", config], { cwd: kok, stdio: "inherit" });
const postject = join(kok, "node_modules", "postject", "dist", "cli.js");
if (!existsSync(postject)) {
  execFileSync("npm", ["install", "--no-save", "postject"], { cwd: kok, stdio: "inherit", shell: true });
}
execFileSync(
  process.execPath,
  [
    postject,
    exe,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { cwd: kok, stdio: "inherit" }
);

function peGuiYap(yol) {
  const buf = Buffer.from(readFileSync(yol));
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x4550) throw new Error("PE imzası yok: " + yol);
  const magic = buf.readUInt16LE(pe + 24);
  const offset = pe + (magic === 0x20b ? 0x5c : 0x5c);
  buf.writeUInt16LE(2, offset); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  writeFileSync(yol, buf);
}

peGuiYap(exe);
console.log("SEA hazır (GUI): " + exe);
