import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "linq",
  errorMessage: "Linq runtime not initialized",
});
export const setLinqRuntime = store.setRuntime;
export const getLinqRuntime = store.getRuntime;
