import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createRouteHandler, createAutoRouteHandler, AUTO_ROUTE_METHOD, ROUTE_METHOD } from "./lib/route.js";

export default definePluginEntry({
  id: "session-router",
  name: "Session Router",
  description: "Dashboard session router: manual routing verb and Jev-judged auto-routing verb.",
  register(api) {
    // Manual routing: a granted dashboard widget picked the target itself.
    api.registerGatewayMethod(ROUTE_METHOD, createRouteHandler({ api }), { scope: "operator.write" });
    // Judged routing: Jev picks the session (Protocol 1 thresholds apply).
    api.registerGatewayMethod(AUTO_ROUTE_METHOD, createAutoRouteHandler({ api }), { scope: "operator.write" });
  },
});
