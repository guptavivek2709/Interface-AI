import { describe, expect, it } from "vitest";
import {
  ConsoleIdentityError,
  StaticConsoleIdentityProvider,
} from "../../src/api/index.js";

describe("StaticConsoleIdentityProvider", () => {
  it("issues opaque cookie sessions and never accepts reusable access codes as bearer tokens", async () => {
    const provider = new StaticConsoleIdentityProvider({
      teller: { accessCode: "correct-teller-access-code", subject: "operator:17", displayName: "Operator 17" },
    });
    const login = await provider.login("correct-teller-access-code", "client-a");
    expect(login.sessionToken).not.toContain("operator");
    expect(login.principal).toMatchObject({ subject: "operator:17", roles: ["teller"] });
    await expect(
      provider.authenticate({ cookieHeader: `other=x; meridian_console=${login.sessionToken}` }),
    ).resolves.toMatchObject({ subject: "operator:17" });
    await expect(
      provider.authenticate({ authorizationHeader: "Bearer correct-teller-access-code" }),
    ).resolves.toBeUndefined();
    await expect(
      provider.authenticate({
        cookieHeader: `meridian_console=${login.sessionToken}`,
        authorizationHeader: "Bearer correct-teller-access-code",
      }),
    ).resolves.toBeUndefined();

    await provider.logout({ cookieHeader: `meridian_console=${login.sessionToken}` });
    await expect(
      provider.authenticate({ cookieHeader: `meridian_console=${login.sessionToken}` }),
    ).resolves.toBeUndefined();
  });

  it("expires idle sessions and rate-limits repeated failed sign-in attempts", async () => {
    let now = 1_000_000;
    const provider = new StaticConsoleIdentityProvider({
      supervisor: { accessCode: "correct-supervisor-access-code" },
      sessionAbsoluteTtlMs: 120_000,
      sessionIdleTtlMs: 60_000,
      maxLoginFailures: 2,
      loginBlockMs: 10_000,
      now: () => now,
    });
    await expect(provider.login("incorrect-access-code-one", "client-b")).rejects.toMatchObject({
      code: "AUTH_INVALID",
    });
    await expect(provider.login("incorrect-access-code-two", "client-b")).rejects.toMatchObject({
      code: "AUTH_INVALID",
    });
    await expect(provider.login("correct-supervisor-access-code", "client-b")).rejects.toMatchObject({
      code: "AUTH_RATE_LIMITED",
    });
    now += 10_001;
    const login = await provider.login("correct-supervisor-access-code", "client-b");
    expect(login.principal.roles).toEqual(["teller", "supervisor"]);
    now += 30_000;
    await expect(
      provider.authenticate({ cookieHeader: `meridian_console=${login.sessionToken}` }),
    ).resolves.toMatchObject({ roles: ["teller", "supervisor"] });
    now += 30_000;
    await expect(
      provider.authenticate({ cookieHeader: `meridian_console=${login.sessionToken}` }),
    ).resolves.toBeUndefined();

    const activeLogin = await provider.login("correct-supervisor-access-code", "client-b");
    now += 30_000;
    await expect(provider.authenticate({
      cookieHeader: `meridian_console=${activeLogin.sessionToken}`,
      touch: true,
    })).resolves.toMatchObject({ roles: ["teller", "supervisor"] });
    now += 30_001;
    await expect(
      provider.authenticate({ cookieHeader: `meridian_console=${activeLogin.sessionToken}` }),
    ).resolves.toMatchObject({ roles: ["teller", "supervisor"] });
  });

  it("fails closed when no identity is configured and rejects weak access codes", async () => {
    const provider = new StaticConsoleIdentityProvider();
    await expect(provider.login("any-access-code-long-enough", "client-c")).rejects.toBeInstanceOf(
      ConsoleIdentityError,
    );
    expect(
      () => new StaticConsoleIdentityProvider({ teller: { accessCode: "too-short" } }),
    ).toThrow(/between 16 and 512/u);
    expect(
      () =>
        new StaticConsoleIdentityProvider({
          teller: { accessCode: "same-console-access-code" },
          supervisor: { accessCode: "same-console-access-code" },
        }),
    ).toThrow(/must be different/u);
    expect(
      () =>
        new StaticConsoleIdentityProvider({
          teller: { accessCode: "first-console-access-code", subject: "shared:operator" },
          supervisor: { accessCode: "second-console-access-code", subject: "shared:operator" },
        }),
    ).toThrow(/subjects must be different/u);
  });
});
