"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/watcher.ts
var import_fs2 = require("fs");
var path = __toESM(require("path"));

// src/blocks.ts
var import_fs = require("fs");
var TIMESTAMP_REGEX = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/;
function parseBlockFilename(file) {
  const dotIdx = file.lastIndexOf(".");
  const base = dotIdx >= 0 ? file.substring(0, dotIdx) : file;
  const underIdx = base.indexOf("_");
  if (underIdx < 0) return null;
  return base.substring(underIdx + 1);
}
async function readBlockTimestamp(filePath) {
  const content = await import_fs.promises.readFile(filePath, "utf8");
  const firstLine = content.split("\n")[0] || "";
  if (!firstLine) return null;
  const match = firstLine.match(TIMESTAMP_REGEX);
  return match ? match[1] : null;
}

// src/watcher.ts
var blocksDir = process.argv[2];
var outputFile = process.argv[3];
var logFile = "/tmp/cargowall-watcher.log";
async function log(msg) {
  await import_fs2.promises.appendFile(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`).catch(() => {
  });
}
var seen = /* @__PURE__ */ new Set();
log(`watcher started: blocks=${blocksDir} output=${outputFile}`);
async function poll() {
  try {
    const files = await import_fs2.promises.readdir(blocksDir);
    for (const file of files) {
      if (seen.has(file)) continue;
      const stepId = parseBlockFilename(file);
      if (!stepId) {
        seen.add(file);
        continue;
      }
      try {
        const ts = await readBlockTimestamp(path.join(blocksDir, file));
        if (ts === null && !await import_fs2.promises.readFile(path.join(blocksDir, file), "utf8")) {
          continue;
        }
        seen.add(file);
        if (ts) {
          log(`timestamp: stepId=${stepId} ts=${ts}`);
          await import_fs2.promises.appendFile(outputFile, JSON.stringify({ id: stepId, ts }) + "\n");
        } else {
          log(`no timestamp match in ${file}`);
        }
      } catch (err) {
        log(`read error for ${file}: ${err}`);
      }
    }
  } catch (err) {
    log(`readdir error: ${err}`);
  }
}
setInterval(poll, 50);
poll();
