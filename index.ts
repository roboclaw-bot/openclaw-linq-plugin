import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { linqPlugin } from "./src/channel.js";
import { setLinqRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "linq",
  name: "Linq",
  description: "Hosted iMessage, RCS and SMS through Linq",
  plugin: linqPlugin,
  setRuntime: setLinqRuntime,
});
