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
var blocksDir = process.argv[2];
var outputFile = process.argv[3];
var logFile = "/tmp/cargowall-watcher.log";
async function log(msg) {
  await import_fs.promises.appendFile(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`).catch(() => {
  });
}
var seen = /* @__PURE__ */ new Set();
var tsRegex = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/;
log(`watcher started: blocks=${blocksDir} output=${outputFile}`);
async function poll() {
  try {
    const files = await import_fs.promises.readdir(blocksDir);
    for (const file of files) {
      if (seen.has(file)) continue;
      const dotIdx = file.lastIndexOf(".");
      const base = dotIdx >= 0 ? file.substring(0, dotIdx) : file;
      const underIdx = base.indexOf("_");
      if (underIdx < 0) {
        seen.add(file);
        continue;
      }
      const stepId = base.substring(underIdx + 1);
      try {
        const content = await import_fs.promises.readFile(path.join(blocksDir, file), "utf8");
        const firstLine = content.split("\n")[0] || "";
        if (!firstLine) {
          continue;
        }
        seen.add(file);
        const match = firstLine.match(tsRegex);
        if (match) {
          log(`timestamp: stepId=${stepId} ts=${match[1]}`);
          await import_fs.promises.appendFile(outputFile, JSON.stringify({ id: stepId, ts: match[1] }) + "\n");
        } else {
          log(`no timestamp match in ${file}: ${firstLine.substring(0, 80)}`);
        }
      } catch (err) {
        log(`read error for ${file}: ${err}`);
      }
    }
  } catch (err) {
    log(`readdir error: ${err}`);
  }
}
setInterval(poll, 200);
poll();
