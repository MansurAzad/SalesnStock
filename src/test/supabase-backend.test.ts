import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ClientOptions = {
  global?: { fetch?: typeof fetch; headers?: Record<string, string> };
  auth?: Record<string, unknown>;
};
type AuthHandler = (args: {
  next: (args: { context: Record<string, unknown> }) => Promise<unknown>;
}) => Promise<unknown>;
type InsightsOptions = {
  server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } };
};

const mocks = vi.hoisted(() => {
  const client = {
    auth: { getClaims: vi.fn(), getUser: vi.fn() },
    from: vi.fn(),
    rpc: vi.fn(),
  };
  return {
    client,
    createClient: vi.fn<(url: string, key: string, options: ClientOptions) => typeof client>(),
    getRequest: vi.fn<() => Request>(),
    fetch: vi.fn<typeof fetch>(),
    createOpenAI: vi.fn(),
    streamText: vi.fn(),
    publishableKey: "sb_publishable_canonical_test_only",
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/integrations/supabase/previewAuthStorage", () => ({
  brokeredPreviewStorage: () => undefined,
}));
// Keep the actual project selection, but never give clients a real credential.
vi.mock("@/integrations/supabase/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/config")>()),
  SUPABASE_PUBLISHABLE_KEY: mocks.publishableKey,
}));
// Expose the real callbacks without starting TanStack's server/router runtime.
vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: AuthHandler) => handler }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: InsightsOptions) => options,
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mocks.createOpenAI }));
vi.mock("ai", () => ({ streamText: mocks.streamText }));

const PROJECT_ID = "fftxkldvtqcgpuryetun";
const CANONICAL_URL = `https://${PROJECT_ID}.supabase.co`;
const FOREIGN_URL = "https://pljmmnilzugyznjajciq.supabase.co";
const FOREIGN_KEY = "sb_publishable_foreign_test_only";
const SERVICE_KEY = "sb_secret_test_only";
const USER_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.test-signature";

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  for (const name of ["VITE_SUPABASE_URL", "SUPABASE_URL"]) {
    vi.stubEnv(name, FOREIGN_URL);
  }
  for (const name of [
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
  ]) {
    vi.stubEnv(name, FOREIGN_KEY);
  }
  vi.stubEnv("VITE_SUPABASE_PROJECT_ID", "pljmmnilzugyznjajciq");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockRejectedValue(new Error("Unexpected network request"));
  mocks.createClient.mockReturnValue(mocks.client);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function clientOptions() {
  const call = mocks.createClient.mock.calls[0];
  expect(mocks.createClient).toHaveBeenCalledTimes(1);
  if (!call) throw new Error("Client was not initialized");
  return call[2];
}

async function publicFetch() {
  const { supabase } = await import("@/integrations/supabase/client");
  expect(supabase.auth).toBe(mocks.client.auth);
  const fetcher = clientOptions().global?.fetch;
  if (!fetcher) throw new Error("Client did not install its custom fetch");
  return fetcher;
}

function sentHeaders() {
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  return new Headers(mocks.fetch.mock.calls[0]?.[1]?.headers);
}

describe("canonical Supabase backend", () => {
  it("pins the migrated project even when build-time and runtime environments disagree", async () => {
    const config = await vi.importActual<typeof import("@/integrations/supabase/config")>(
      "@/integrations/supabase/config",
    );

    expect(config.SUPABASE_PROJECT_ID).toBe(PROJECT_ID);
    expect(config.SUPABASE_URL).toBe(CANONICAL_URL);
    expect(config.SUPABASE_PUBLISHABLE_KEY).toMatch(/^sb_publishable_/);
    expect(config.SUPABASE_PUBLISHABLE_KEY).not.toBe(FOREIGN_KEY);
  });

  it("initializes the public client with canonical config, not injected environment values", async () => {
    await publicFetch();

    expect(mocks.createClient).toHaveBeenCalledWith(
      CANONICAL_URL,
      mocks.publishableKey,
      expect.objectContaining({
        auth: expect.objectContaining({ persistSession: true, autoRefreshToken: true }),
      }),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["init", "request"] as const)(
    "strips an opaque API-key bearer from %s headers while retaining apikey",
    async (source) => {
      const fetcher = await publicFetch();
      const headers = {
        Authorization: `Bearer ${mocks.publishableKey}`,
        apikey: FOREIGN_KEY,
        "X-Client-Info": "regression-test",
      };
      const response = new Response("[]");
      mocks.fetch.mockResolvedValue(response);
      const url = `${CANONICAL_URL}/rest/v1/branches`;
      const result =
        source === "request"
          ? await fetcher(new Request(url, { headers }))
          : await fetcher(url, { headers });

      expect(result).toBe(response);
      expect(sentHeaders().has("authorization")).toBe(false);
      expect(sentHeaders().get("apikey")).toBe(mocks.publishableKey);
      expect(sentHeaders().get("x-client-info")).toBe("regression-test");
    },
  );

  it.each(["init", "request"] as const)(
    "preserves a user's bearer JWT in %s headers",
    async (source) => {
      const fetcher = await publicFetch();
      mocks.fetch.mockResolvedValue(new Response("[]"));
      const headers = { authorization: `Bearer ${USER_JWT}` };
      const url = `${CANONICAL_URL}/rest/v1/branches`;
      if (source === "request") {
        await fetcher(new Request(url, { headers }));
      } else {
        await fetcher(url, { headers });
      }

      expect(sentHeaders().get("authorization")).toBe(`Bearer ${USER_JWT}`);
      expect(sentHeaders().get("apikey")).toBe(mocks.publishableKey);
    },
  );

  it("lets caller headers override Request headers without losing the user JWT or request options", async () => {
    const fetcher = await publicFetch();
    mocks.fetch.mockResolvedValue(new Response("{}"));
    const request = new Request(`${CANONICAL_URL}/rest/v1/rpc/report_sales`, {
      headers: {
        Authorization: `Bearer ${mocks.publishableKey}`,
        "X-Request-Header": "retained",
      },
    });
    const signal = new AbortController().signal;
    await fetcher(request, {
      method: "POST",
      body: "{}",
      signal,
      headers: new Headers({ authorization: `Bearer ${USER_JWT}`, "X-Caller": "retained" }),
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ method: "POST", body: "{}", signal }),
    );
    expect(sentHeaders().get("authorization")).toBe(`Bearer ${USER_JWT}`);
    expect(sentHeaders().get("apikey")).toBe(mocks.publishableKey);
    expect(sentHeaders().get("x-request-header")).toBe("retained");
    expect(sentHeaders().get("x-caller")).toBe("retained");
  });

  it("authenticates middleware against the same backend and preserves the caller's identity", async () => {
    mocks.getRequest.mockReturnValue(
      new Request("https://app.test/", { headers: { authorization: `Bearer ${USER_JWT}` } }),
    );
    const claims = { sub: "test-user", role: "authenticated" };
    mocks.client.auth.getClaims.mockResolvedValue({ data: { claims }, error: null });
    const next = vi.fn().mockResolvedValue("authorized");
    const { requireSupabaseAuth } = await import("@/integrations/supabase/auth-middleware");

    await expect((requireSupabaseAuth as unknown as AuthHandler)({ next })).resolves.toBe(
      "authorized",
    );
    expect(mocks.createClient).toHaveBeenCalledWith(
      CANONICAL_URL,
      mocks.publishableKey,
      expect.objectContaining({
        global: expect.objectContaining({ headers: { Authorization: `Bearer ${USER_JWT}` } }),
      }),
    );
    expect(mocks.client.auth.getClaims).toHaveBeenCalledWith(USER_JWT);
    expect(next).toHaveBeenCalledWith({
      context: { supabase: mocks.client, userId: "test-user", claims },
    });
    const options = clientOptions();
    mocks.fetch.mockResolvedValue(new Response("{}"));
    await options.global!.fetch!(`${CANONICAL_URL}/auth/v1/user`, {
      headers: options.global!.headers!,
    });
    expect(sentHeaders().get("authorization")).toBe(`Bearer ${USER_JWT}`);
    expect(sentHeaders().get("apikey")).toBe(mocks.publishableKey);
  });

  it("initializes insights on the canonical backend with the caller's token", async () => {
    mocks.client.auth.getUser.mockResolvedValue({ data: { user: { id: "test-user" } } });
    const { Route } = await import("@/routes/api/insights");
    // A blank question stops after authentication, before database reads or AI calls.
    const response = await (Route as unknown as InsightsOptions).server.handlers.POST({
      request: new Request("https://app.test/api/insights", {
        method: "POST",
        headers: { authorization: `Bearer ${USER_JWT}`, "Content-Type": "application/json" },
        body: JSON.stringify({ question: " " }),
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Please type a question");
    expect(mocks.createClient).toHaveBeenCalledWith(
      CANONICAL_URL,
      mocks.publishableKey,
      expect.objectContaining({
        global: { headers: { Authorization: `Bearer ${USER_JWT}` } },
      }),
    );
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.client.auth.getUser).toHaveBeenCalledWith(USER_JWT);
    expect(mocks.client.from).not.toHaveBeenCalled();
    expect(mocks.createOpenAI).not.toHaveBeenCalled();
    expect(mocks.streamText).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("admin backend guard", () => {
  it.each([FOREIGN_URL, undefined])(
    "refuses SUPABASE_URL=%s before constructing a client or making a request",
    async (url) => {
      vi.stubEnv("SUPABASE_URL", url);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      expect(() => supabaseAdmin.auth).toThrow(/configured Supabase project/);
      expect(mocks.createClient).not.toHaveBeenCalled();
      expect(mocks.client.rpc).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it("refuses a missing service key before constructing a client", async () => {
    vi.stubEnv("SUPABASE_URL", CANONICAL_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    expect(() => supabaseAdmin.auth).toThrow(/Missing SUPABASE_SERVICE_ROLE_KEY/);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([CANONICAL_URL, `${CANONICAL_URL}/`])(
    "accepts matching server URL %s and uses canonical config",
    async (url) => {
      vi.stubEnv("SUPABASE_URL", url);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      expect(supabaseAdmin.auth).toBe(mocks.client.auth);
      expect(mocks.createClient).toHaveBeenCalledWith(
        CANONICAL_URL,
        SERVICE_KEY,
        expect.objectContaining({
          auth: expect.objectContaining({ persistSession: false, autoRefreshToken: false }),
        }),
      );
      expect(mocks.createClient).toHaveBeenCalledTimes(1);
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
});
