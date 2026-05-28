import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";

const companiesTable = companies as any;

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".md" || ext === ".markdown") return "text/markdown; charset=utf-8";
  if (ext === ".csv") return "text/csv; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".txt") return "text/plain; charset=utf-8";

  return "application/octet-stream";
}

function dataRoot(): string {
  return (
    process.env.PAPERCLIP_DATA_DIR ||
    process.env.PAPERCLIP_HOME ||
    "/paperclip"
  );
}

function docsRootForCompanyId(companyId: string): string {
  return path.resolve(
    dataRoot(),
    "instances",
    "default",
    "companies",
    companyId,
    "docs"
  );
}

function companiesRoot(): string {
  return path.resolve(dataRoot(), "instances", "default", "companies");
}

function matchesPrefix(row: any, prefix: string): boolean {
  const wanted = prefix.toUpperCase();

  const candidates = [
    row?.prefix,
    row?.issuePrefix,
    row?.issue_prefix,
    row?.keyPrefix,
    row?.key_prefix,
    row?.slug,
    row?.code,
    row?.shortCode,
    row?.short_code,
    row?.name,
  ];

  return candidates.some((value) => String(value ?? "").toUpperCase() === wanted);
}

async function getCompanyByPrefix(db: any, prefix: string): Promise<any | null> {
  const rows = await db.select().from(companiesTable);

  return rows.find((row: any) => matchesPrefix(row, prefix)) ?? null;
}

async function getCompanyById(db: any, companyId: string): Promise<any | null> {
  const rows = await db
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);

  return rows[0] ?? null;
}

async function findCompanyIdByExistingDoc(requestedPath: string): Promise<string | null> {
  const root = companiesRoot();

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const companyId = entry.name;
    const docsRoot = docsRootForCompanyId(companyId);
    const resolvedFile = path.resolve(docsRoot, requestedPath);

    if (!resolvedFile.startsWith(docsRoot + path.sep)) continue;

    try {
      const stat = await fs.stat(resolvedFile);
      if (stat.isFile()) matches.push(companyId);
    } catch {
      continue;
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

async function resolveCompanyIdForPrefix(
  db: any,
  prefix: string,
  requestedPath: string
): Promise<string | null> {
  try {
    const company = await getCompanyByPrefix(db, prefix);
    if (company?.id) return company.id;
  } catch {
    // Fall through to filesystem lookup.
  }

  return findCompanyIdByExistingDoc(requestedPath);
}

async function serveCompanyDoc(
  res: any,
  companyId: string,
  requestedPath: string
): Promise<void> {
  const docsRoot = docsRootForCompanyId(companyId);
  const resolvedFile = path.resolve(docsRoot, requestedPath);

  if (!resolvedFile.startsWith(docsRoot + path.sep)) {
    res.status(400).send("Invalid document path");
    return;
  }

  try {
    const stat = await fs.stat(resolvedFile);

    if (!stat.isFile()) {
      res.status(404).send("Document not found");
      return;
    }

    const body = await fs.readFile(resolvedFile);

    res.setHeader("content-type", contentTypeFor(resolvedFile));
    res.setHeader("x-content-type-options", "nosniff");
    res.send(body);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      res.status(404).send("Document not found");
      return;
    }

    throw error;
  }
}

export function createCompanyDocsRouter(db: any) {
  const router = Router();

  router.get(
    /^\/paperclip\/instances\/default\/companies\/([^/]+)\/docs\/(.+)$/,
    async (req, res, next) => {
      try {
        const companyId = req.params[0];
        const requestedPath = req.params[1];

        const company = await getCompanyById(db, companyId);

        if (!company) {
          const docsRoot = docsRootForCompanyId(companyId);
          const resolvedFile = path.resolve(docsRoot, requestedPath);

          if (!resolvedFile.startsWith(docsRoot + path.sep)) {
            res.status(400).send("Invalid document path");
            return;
          }
        }

        await serveCompanyDoc(res, companyId, requestedPath);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(/^\/([^/]+)\/docs\/(.+)$/, async (req, res, next) => {
    try {
      const companyPrefix = req.params[0];
      const requestedPath = req.params[1];

      const companyId = await resolveCompanyIdForPrefix(
        db,
        companyPrefix,
        requestedPath
      );

      if (!companyId) {
        res.status(404).send("Company/document not found");
        return;
      }

      await serveCompanyDoc(res, companyId, requestedPath);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createCompanyDocsRouter;
