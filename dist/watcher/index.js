/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 923:
/***/ (function(__unused_webpack_module, exports, __nccwpck_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
const fs_1 = __nccwpck_require__(896);
const path = __importStar(__nccwpck_require__(928));
const blocksDir = process.argv[2];
const outputFile = process.argv[3];
const logFile = '/tmp/cargowall-watcher.log';
async function log(msg) {
    await fs_1.promises.appendFile(logFile, `${new Date().toISOString()} ${msg}\n`).catch(() => { });
}
const seen = new Set();
const tsRegex = /^\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/;
log(`watcher started: blocks=${blocksDir} output=${outputFile}`);
async function poll() {
    try {
        const files = await fs_1.promises.readdir(blocksDir);
        for (const file of files) {
            if (seen.has(file))
                continue;
            // Extract step ID from filename: {jobId}_{stepId}.{page}
            const dotIdx = file.lastIndexOf('.');
            const base = dotIdx >= 0 ? file.substring(0, dotIdx) : file;
            const underIdx = base.indexOf('_');
            if (underIdx < 0) {
                seen.add(file);
                continue;
            }
            const stepId = base.substring(underIdx + 1);
            // Read first line for sub-second timestamp
            try {
                const content = await fs_1.promises.readFile(path.join(blocksDir, file), 'utf8');
                const firstLine = content.split('\n')[0] || '';
                if (!firstLine) {
                    // File exists but is empty — retry next poll (runner hasn't written yet)
                    continue;
                }
                seen.add(file);
                const match = firstLine.match(tsRegex);
                if (match) {
                    log(`timestamp: stepId=${stepId} ts=${match[1]}`);
                    await fs_1.promises.appendFile(outputFile, JSON.stringify({ id: stepId, ts: match[1] }) + '\n');
                }
                else {
                    log(`no timestamp match in ${file}: ${firstLine.substring(0, 80)}`);
                }
            }
            catch (err) {
                // File may have been deleted or not yet readable — retry next poll
                log(`read error for ${file}: ${err}`);
            }
        }
    }
    catch (err) {
        log(`readdir error: ${err}`);
    }
}
// Poll every 200ms
setInterval(poll, 200);
poll();


/***/ }),

/***/ 896:
/***/ ((module) => {

module.exports = require("fs");

/***/ }),

/***/ 928:
/***/ ((module) => {

module.exports = require("path");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId].call(module.exports, module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __nccwpck_require__(923);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;