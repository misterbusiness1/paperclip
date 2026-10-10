#!/usr/bin/env node

import { appendFileSync } from "node:fs";

export function resolveImageBuildInputs(sourceRef, fallbackSha, repository) {
  const sourceSha = sourceRef || fallbackSha;
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("source_ref must be a full lowercase 40-character commit SHA");
  }

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be an owner/name pair");
  }

  return {
    sourceSha,
    imageRepository: `ghcr.io/${repository.toLowerCase()}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sourceRef = "", fallbackSha = "", repository = ""] = process.argv.slice(2);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  const resolved = resolveImageBuildInputs(sourceRef, fallbackSha, repository);
  appendFileSync(outputPath, `source_sha=${resolved.sourceSha}\nimage_repository=${resolved.imageRepository}\n`);
}
