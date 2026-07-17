import { EnvironmentId, ProjectId } from "@t4code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ selects: [] as Array<Record<string, unknown>> }));

vi.mock("./ui/select", () => {
  const Wrapper = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Select: (props: Record<string, unknown>) => {
      harness.selects.push(props);
      return <>{props.children as React.ReactNode}</>;
    },
    SelectGroup: Wrapper,
    SelectGroupLabel: Wrapper,
    SelectItem: Wrapper,
    SelectPopup: Wrapper,
    SelectTrigger: Wrapper,
    SelectValue: () => <span>Selected environment</span>,
  };
});

import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");
const availableEnvironments = [
  {
    environmentId: primary,
    projectId: ProjectId.make("project-primary"),
    label: "Local",
    isPrimary: true,
  },
  {
    environmentId: remote,
    projectId: ProjectId.make("project-remote"),
    label: "Cloud",
    isPrimary: false,
  },
];

beforeEach(() => {
  harness.selects.length = 0;
});

describe("BranchToolbarEnvironmentSelector", () => {
  it("renders locked primary, remote, and missing environment labels", () => {
    const props = { availableEnvironments, envLocked: true, onEnvironmentChange: vi.fn() };
    expect(
      renderToStaticMarkup(<BranchToolbarEnvironmentSelector {...props} environmentId={primary} />),
    ).toContain("Local");
    expect(
      renderToStaticMarkup(<BranchToolbarEnvironmentSelector {...props} environmentId={remote} />),
    ).toContain("Cloud");
    expect(
      renderToStaticMarkup(
        <BranchToolbarEnvironmentSelector
          {...props}
          environmentId={EnvironmentId.make("missing")}
        />,
      ),
    ).toContain("Run on");
  });

  it("renders selectable environments and forwards changes", () => {
    const onEnvironmentChange = vi.fn();
    const markup = renderToStaticMarkup(
      <BranchToolbarEnvironmentSelector
        envLocked={false}
        environmentId={remote}
        availableEnvironments={availableEnvironments}
        onEnvironmentChange={onEnvironmentChange}
      />,
    );

    expect(markup).toContain("Local");
    expect(markup).toContain("Cloud");
    expect(harness.selects[0]).toMatchObject({
      modal: false,
      value: remote,
      items: [
        { value: primary, label: "Local" },
        { value: remote, label: "Cloud" },
      ],
    });
    (harness.selects[0]!.onValueChange as (value: string) => void)("primary");
    expect(onEnvironmentChange).toHaveBeenCalledWith("primary");
  });
});
