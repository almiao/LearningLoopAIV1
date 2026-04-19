#!/usr/bin/env node

import { ensureRuntimeDirs, stopTrackedServices } from "./service-runtime.mjs";

ensureRuntimeDirs();
stopTrackedServices();
console.log("Split services stopped.");
