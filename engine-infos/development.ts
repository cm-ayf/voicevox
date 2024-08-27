import type { DefaultEngineInfos, EngineId } from "./types";

export default [
  {
    uuid: "074fc39e-678b-4c13-8916-ffca8d505d1d" as EngineId,
    name: "VOICEVOX Engine",
    executionEnabled: true,
    executionFilePath:
      "/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run",
    executionArgs: [],
    host: "http://127.0.0.1:50021",
  },
] satisfies DefaultEngineInfos;
