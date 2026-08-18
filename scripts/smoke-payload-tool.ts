import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAYLOAD = "A".repeat(6_000);

const smokePayloadTool = defineTool({
  name: "pi_condense_smoke_payload",
  label: "Pi-condense smoke payload",
  description: "Returns a fixed 6,000-character payload for the authenticated pi-condense smoke test.",
  parameters: Type.Object({}),
  async execute() {
    return {
      content: [{ type: "text", text: PAYLOAD }],
      details: { bytes: PAYLOAD.length, deterministic: true },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(smokePayloadTool);
}
