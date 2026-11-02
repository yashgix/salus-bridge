// v1 has no real Salus calls: everything runs against the local in-process mock (src/decide/mock.ts).
// SALUS_BRIDGE_MODE unset or "mock" is the only accepted value; anything else fails closed BEFORE any client, mock or
// network call is set up, so a misconfiguration can never silently fall back to something else.

export const MOCK_API_KEY = "local-mock-key"; // not a Salus key; only the in-process mock ever sees it
export const MOCK_BASE_URL = "http://salus.mock.invalid/v1"; // never resolved: the mock's fetch is injected

export function modeError(env: Record<string, string | undefined>): string | undefined {
  const mode = env.SALUS_BRIDGE_MODE;
  if (mode === undefined || mode === "mock") return undefined;
  return `salus-bridge: SALUS_BRIDGE_MODE=${JSON.stringify(mode)} is not supported. v1 has no real Salus calls; ` +
    `unset it or set it to "mock". Refusing to start (fail closed).`;
}

// For entry points: exits non-zero with a stderr message when the mode is not the local mock.
export function requireMockMode(): void {
  const error = modeError(process.env);
  if (error === undefined) return;
  process.stderr.write(error + "\n");
  process.exit(2);
}
