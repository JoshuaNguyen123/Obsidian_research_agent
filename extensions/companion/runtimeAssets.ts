import auth from "../../companion/auth.py";
import browserService from "../../companion/browser_service.py";
import browserSecurity from "../../companion/browser_security.py";
import companionControl from "../../companion/companion_control.py";
import config from "../../companion/config.py";
import coordinatorStore from "../../companion/coordinator_store.py";
import memoryStore from "../../companion/memory_store.py";
import persistedData from "../../companion/persisted_data.py";
import runtimePreflight from "../../companion/runtime_preflight.py";
import runtimeLock from "../../companion/runtime-lock.json";
import schemas from "../../companion/schemas.py";
import secureStore from "../../companion/secure_store.py";
import server from "../../companion/server.py";
import serviceLauncher from "../../companion/service_launcher.py";
import serviceManager from "../../companion/service_manager.py";
import webExtract from "../../companion/web_extract.py";
import requirements from "../../companion/requirements.txt";
import ruffleHost from "../../companion/static/ruffle-host.html";
import standaloneWorker from "./generated/standalone-worker.txt";

/** Text assets embedded directly in the independently installed main.js. */
export const COMPANION_RUNTIME_ASSETS_V1: Readonly<Record<string, string>> =
  Object.freeze({
    "auth.py": auth,
    "browser_service.py": browserService,
    "browser_security.py": browserSecurity,
    "companion_control.py": companionControl,
    "config.py": config,
    "coordinator_store.py": coordinatorStore,
    "memory_store.py": memoryStore,
    "persisted_data.py": persistedData,
    "runtime_preflight.py": runtimePreflight,
    "runtime-lock.json":
      typeof runtimeLock === "string"
        ? runtimeLock
        : JSON.stringify(runtimeLock as unknown, null, 2),
    "schemas.py": schemas,
    "secure_store.py": secureStore,
    "server.py": server,
    "service_launcher.py": serviceLauncher,
    "service_manager.py": serviceManager,
    "web_extract.py": webExtract,
    "requirements.txt": requirements,
    "static/ruffle-host.html": ruffleHost,
    "standalone-worker.cjs": standaloneWorker,
  });
