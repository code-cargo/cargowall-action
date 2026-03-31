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
var import_fs = require("fs");
var path = __toESM(require("path"));

// src/blocks.ts
var TIMESTAMP_REGEX = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/;
function parseBlockFilename(file) {
  const dotIdx = file.lastIndexOf(".");
  const base = dotIdx >= 0 ? file.substring(0, dotIdx) : file;
  const underIdx = base.indexOf("_");
  if (underIdx < 0) return null;
  const stepId = base.substring(underIdx + 1);
  return stepId || null;
}

// src/watcher.ts
var blocksDir = process.argv[2];
var outputFile = process.argv[3];
var logFile = "/tmp/cargowall-watcher.log";
async function log(msg) {
  await import_fs.promises.appendFile(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`).catch(() => {
  });
}
var seen = /* @__PURE__ */ new Set();
var seenStepIds = /* @__PURE__ */ new Set();
log(`watcher started: blocks=${blocksDir} output=${outputFile}`);
async function poll() {
  try {
    const files = await import_fs.promises.readdir(blocksDir);
    for (const file of files) {
      if (seen.has(file)) continue;
      const stepId = parseBlockFilename(file);
      if (!stepId || seenStepIds.has(stepId)) {
        seen.add(file);
        continue;
      }
      try {
        const fh = await import_fs.promises.open(path.join(blocksDir, file), "r");
        try {
          const buf = Buffer.alloc(256);
          const { bytesRead } = await fh.read(buf, 0, 256, 0);
          if (bytesRead === 0) {
            continue;
          }
          const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0] || "";
          const match = firstLine.match(TIMESTAMP_REGEX);
          if (match) {
            seen.add(file);
            seenStepIds.add(stepId);
            log(`timestamp: stepId=${stepId} ts=${match[1]}`);
            await import_fs.promises.appendFile(outputFile, JSON.stringify({ id: stepId, ts: match[1] }) + "\n");
          } else {
            log(`no timestamp match in ${file}, will retry`);
          }
        } finally {
          await fh.close();
        }
      } catch (err) {
        log(`read error for ${file}: ${err}`);
      }
    }
  } catch (err) {
    log(`readdir error: ${err}`);
  }
}
async function startPolling() {
  await poll();
  setTimeout(startPolling, 200);
}
startPolling();
