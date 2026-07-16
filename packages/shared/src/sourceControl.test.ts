import { describe, expect, it } from "vite-plus/test";

import {
  detectSourceControlProviderFromRemoteUrl,
  formatChangeRequestAction,
  formatCreateChangeRequestPhrase,
  getChangeRequestTerminology,
  getChangeRequestTerminologyForKind,
  resolveChangeRequestPresentation,
  resolveChangeRequestPresentationForKind,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("uses merge request terminology for GitLab", () => {
    expect(getChangeRequestTerminologyForKind("gitlab")).toEqual({
      shortLabel: "MR",
      singular: "merge request",
    });
  });

  it("uses pull request terminology for GitHub-compatible providers", () => {
    expect(getChangeRequestTerminologyForKind("github")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("azure-devops")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(getChangeRequestTerminologyForKind("bitbucket")).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({ kind: "unknown", name: "forge", baseUrl: "" }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });

  it("resolves every presentation and formats action copy", () => {
    expect(resolveChangeRequestPresentation(null).providerName).toBe("GitHub");
    expect(resolveChangeRequestPresentationForKind("gitlab").icon).toBe("gitlab");
    expect(resolveChangeRequestPresentationForKind("azure-devops").icon).toBe("azure-devops");
    expect(resolveChangeRequestPresentationForKind("bitbucket").icon).toBe("bitbucket");

    const generic = resolveChangeRequestPresentationForKind("unknown");
    expect(formatChangeRequestAction("View", generic)).toBe("View change request");
    expect(formatChangeRequestAction("Create", generic)).toBe("Create change request");
    expect(formatCreateChangeRequestPhrase(generic)).toBe("create change request");
  });

  it("uses defaults for missing provider information and provider-specific terminology otherwise", () => {
    expect(getChangeRequestTerminology(undefined)).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
    expect(
      getChangeRequestTerminology({
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      }),
    ).toEqual({ shortLabel: "MR", singular: "merge request" });
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects common source control hosts", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
    ).toBe("gitlab");
    expect(
      detectSourceControlProviderFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")?.kind,
    ).toBe("azure-devops");
    expect(
      detectSourceControlProviderFromRemoteUrl("git@bitbucket.org:workspace/repo.git")?.kind,
    ).toBe("bitbucket");
  });

  it("preserves ports while classifying by hostname", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com:8443/group/repo.git"),
    ).toEqual({
      kind: "gitlab",
      name: "GitLab",
      baseUrl: "https://gitlab.com:8443",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://self-hosted.example.test:8443/group/repo.git",
      ),
    ).toEqual({
      kind: "unknown",
      name: "self-hosted.example.test:8443",
      baseUrl: "https://self-hosted.example.test:8443",
    });
  });

  it("detects self-hosted and alternate provider host forms", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("git@github.company.test/team/repo.git"),
    ).toEqual({
      kind: "github",
      name: "GitHub Self-Hosted",
      baseUrl: "https://github.company.test",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.company.test/team/repo.git"),
    ).toEqual({
      kind: "gitlab",
      name: "GitLab Self-Hosted",
      baseUrl: "https://gitlab.company.test",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl("https://organization.visualstudio.com/project"),
    ).toEqual({
      kind: "azure-devops",
      name: "Azure DevOps",
      baseUrl: "https://organization.visualstudio.com",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl("https://bitbucket.company.test/team/repo.git"),
    ).toEqual({
      kind: "bitbucket",
      name: "Bitbucket Self-Hosted",
      baseUrl: "https://bitbucket.company.test",
    });
  });

  it("returns null for empty or invalid remotes", () => {
    expect(detectSourceControlProviderFromRemoteUrl("")).toBeNull();
    expect(detectSourceControlProviderFromRemoteUrl("   ")).toBeNull();
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com")).toBeNull();
    expect(detectSourceControlProviderFromRemoteUrl("not a remote")).toBeNull();
  });

  it("preserves an unrecognized scp host even when URL hostname parsing rejects it", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@bad host:team/repo.git")).toEqual({
      kind: "unknown",
      name: "bad host",
      baseUrl: "https://bad host",
    });
  });
});
