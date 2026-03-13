const { execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const bridgeScriptPath = path.join(__dirname, "scripts", "opencode-bridge.ps1");

const requestFile = path.join(os.tmpdir(), "atlasforge-test.json");
const payload = JSON.stringify({ message: "hello", threadId: "" });

console.log("Writing request file:", requestFile);
fs.writeFileSync(requestFile, payload, "utf8");

console.log("Calling bridge script...");
console.log("Bridge path:", bridgeScriptPath);

execFile(
  "powershell.exe",
  [
    "-NoLogo",
    "-NonInteractive", 
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    bridgeScriptPath,
    "-RequestFile",
    requestFile,
  ],
  {
    cwd: os.homedir(),
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true,
    timeout: 120000,
  },
  (error, stdout, stderr) => {
    fs.unlinkSync(requestFile);
    
    console.log("ERROR:", error);
    console.log("STDOUT:", stdout);
    console.log("STDERR:", stderr);
  }
);
