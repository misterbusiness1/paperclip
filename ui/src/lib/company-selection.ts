export type CompanySelectionSource = "manual" | "route_sync" | "bootstrap";

export function resolveUnknownCompanyPrefixFallback(params: {
  companies: Array<{ id: string; issuePrefix: string }>;
  requestedPrefix: string;
  selectedCompanyId: string | null;
}) {
  const requestedPrefix = params.requestedPrefix.toUpperCase();
  const prefixExtensions = params.companies.filter((company) =>
    company.issuePrefix.toUpperCase().startsWith(requestedPrefix),
  );
  if (prefixExtensions.length === 1) return prefixExtensions[0]!;
  return params.companies.find((company) => company.id === params.selectedCompanyId)
    ?? params.companies[0]
    ?? null;
}

export function shouldSyncCompanySelectionFromRoute(params: {
  selectionSource: CompanySelectionSource;
  selectedCompanyId: string | null;
  routeCompanyId: string;
}): boolean {
  const { selectionSource, selectedCompanyId, routeCompanyId } = params;

  if (selectedCompanyId === routeCompanyId) return false;

  // Let manual company switches finish their remembered-path navigation first.
  if (selectionSource === "manual" && selectedCompanyId) {
    return false;
  }

  return true;
}
