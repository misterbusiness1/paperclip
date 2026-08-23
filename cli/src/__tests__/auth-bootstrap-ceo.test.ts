import { afterEach, describe, expect, it } from "vitest";
import { resolveBootstrapDeploymentMode } from "../commands/auth-bootstrap-ceo.js";

const originalDeploymentMode = process.env.PAPERCLIP_DEPLOYMENT_MODE;

afterEach(() => {
  if (originalDeploymentMode === undefined) delete process.env.PAPERCLIP_DEPLOYMENT_MODE;
  else process.env.PAPERCLIP_DEPLOYMENT_MODE = originalDeploymentMode;
});

describe("bootstrap CEO deployment mode", () => {
  it("supports authenticated deployments configured entirely by environment", () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    expect(resolveBootstrapDeploymentMode(null)).toBe("authenticated");
  });

  it.each(["Authenticated", "authenticated "])("rejects the near-miss environment value %j", (value) => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = value;
    expect(resolveBootstrapDeploymentMode(null)).not.toBe("authenticated");
  });

  it("keeps a real config authoritative over the environment", () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    expect(resolveBootstrapDeploymentMode({ server: { deploymentMode: "local_trusted" } })).toBe("local_trusted");
  });
});
