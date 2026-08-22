import { describe, expect, it } from "vitest";
import {
  resolveUnknownCompanyPrefixFallback,
  shouldSyncCompanySelectionFromRoute,
} from "./company-selection";

describe("resolveUnknownCompanyPrefixFallback", () => {
  const companies = [
    { id: "origin", issuePrefix: "ORI" },
    { id: "oxford", issuePrefix: "OXFA" },
  ];

  it("redirects an obsolete prefix to its unique surviving extension", () => {
    expect(resolveUnknownCompanyPrefixFallback({
      companies,
      requestedPrefix: "OXF",
      selectedCompanyId: "origin",
    })).toEqual(companies[1]);
  });

  it("uses the valid selection when a prefix extension is ambiguous", () => {
    expect(resolveUnknownCompanyPrefixFallback({
      companies: [...companies, { id: "other-oxford", issuePrefix: "OXFB" }],
      requestedPrefix: "OXF",
      selectedCompanyId: "origin",
    })).toEqual(companies[0]);
  });
});

describe("shouldSyncCompanySelectionFromRoute", () => {
  it("does not resync when selection already matches the route", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "route_sync",
        selectedCompanyId: "pap",
        routeCompanyId: "pap",
      }),
    ).toBe(false);
  });

  it("defers route sync while a manual company switch is in flight", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "manual",
        selectedCompanyId: "pap",
        routeCompanyId: "ret",
      }),
    ).toBe(false);
  });

  it("syncs back to the route company for non-manual mismatches", () => {
    expect(
      shouldSyncCompanySelectionFromRoute({
        selectionSource: "route_sync",
        selectedCompanyId: "pap",
        routeCompanyId: "ret",
      }),
    ).toBe(true);
  });
});
