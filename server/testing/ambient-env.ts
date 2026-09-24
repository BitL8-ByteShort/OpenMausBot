// These are test-runner controls, not app configuration. In particular, CI
// sets OMB_UI_E2E to force the browser smoke instead of silently skipping it.
const testControls = new Set([
  "OMB_AGENT_BROWSER_PATH",
  "OMB_OPENCODE_E2E_CLI",
  "OMB_RUN_FEEDBACK_SCREENSHOT",
  "OMB_UI_E2E",
  "OMB_UI_EVIDENCE_DIR",
]);

export function stripAmbientAppEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if ((key.startsWith("OMB_") || key.startsWith("OPENMAUSBOT_")) && !testControls.has(key)) {
      delete env[key];
    }
  }
}
