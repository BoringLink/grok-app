import { describe, expect, it } from "vitest";
import { resolveSessionProviderRoute } from "./sessionProviderRoute";

const providers = [{ id: "relay" }, { id: "other" }];

describe("resolveSessionProviderRoute", () => {
  it("uses official when the chat has no provider preference", () => {
    expect(
      resolveSessionProviderRoute({
        providerId: null,
        providers,
        providersLoaded: true,
      }),
    ).toEqual({ source: "official", providerId: null });
  });

  it("uses the chat's configured custom provider", () => {
    expect(
      resolveSessionProviderRoute({
        providerId: "relay",
        providers,
        providersLoaded: true,
      }),
    ).toEqual({ source: "custom", providerId: "relay" });
  });

  it("treats an explicit official id as the official route", () => {
    expect(
      resolveSessionProviderRoute({
        providerId: "official",
        providers,
        providersLoaded: true,
      }),
    ).toEqual({ source: "official", providerId: null });
  });

  it("normalizes whitespace and case for an explicit official id", () => {
    expect(
      resolveSessionProviderRoute({
        providerId: " Official ",
        providers,
        providersLoaded: true,
      }),
    ).toEqual({ source: "official", providerId: null });
  });

  it("falls back to official after the provider is deleted", () => {
    expect(
      resolveSessionProviderRoute({
        providerId: "removed",
        providers,
        providersLoaded: true,
      }),
    ).toEqual({ source: "official", providerId: null });
  });

  it("keeps a stored provider on screen until the list has loaded", () => {
    expect(
      resolveSessionProviderRoute({
        providerId: "relay",
        providers: [],
        providersLoaded: false,
      }),
    ).toEqual({ source: "custom", providerId: "relay" });
  });

  it("falls back to official for an empty loaded provider list", () => {
    expect(
      resolveSessionProviderRoute({
        providerId: "relay",
        providers: [],
        providersLoaded: true,
      }),
    ).toEqual({ source: "official", providerId: null });
  });
});
