import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { linqSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(linqSetupPlugin);
