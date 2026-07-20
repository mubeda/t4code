import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import {
  ProviderDriverKind,
  type ProviderSessionDefault,
  type ServerProviderModel,
} from "@t4code/contracts";

const controls = vi.hoisted(() => {
  const state = {
    entries: [] as Array<{
      readonly kind: "Select" | "Switch";
      readonly props: Record<string, unknown>;
    }>,
    reset() {
      state.entries.length = 0;
    },
  };
  return state;
});

vi.mock("../ui/select", () => {
  const Wrapper = ({ children }: { readonly children?: ReactNode }) => <>{children}</>;
  return {
    Select: ({
      children,
      ...props
    }: { readonly children?: ReactNode } & Record<string, unknown>) => {
      controls.entries.push({ kind: "Select", props });
      return <>{children}</>;
    },
    SelectItem: Wrapper,
    SelectPopup: Wrapper,
    SelectTrigger: ({
      children,
      ...props
    }: { readonly children?: ReactNode } & Record<string, unknown>) => (
      <button
        aria-label={props["aria-label"] as string | undefined}
        id={props.id as string | undefined}
        type="button"
      >
        {children}
      </button>
    ),
    SelectValue: () => <span />,
  };
});

vi.mock("../ui/switch", () => ({
  Switch: (props: Record<string, unknown>) => {
    controls.entries.push({ kind: "Switch", props });
    return (
      <button
        aria-label={props["aria-label"] as string | undefined}
        id={props.id as string | undefined}
        type="button"
      />
    );
  },
}));

import { ProviderSessionDefaultsControls } from "./ProviderSessionDefaultsControls";

const CODEX = ProviderDriverKind.make("codex");
const OPENCODE = ProviderDriverKind.make("opencode");

function model(
  slug: string,
  optionDescriptors: NonNullable<ServerProviderModel["capabilities"]>["optionDescriptors"] = [],
): ServerProviderModel {
  return {
    slug,
    name: slug === "gpt-rich" ? "GPT Rich" : slug,
    isCustom: false,
    capabilities: { optionDescriptors },
  };
}

const richModels = [
  model("gpt-rich", [
    {
      id: "variant",
      label: "Variant",
      type: "select",
      options: [{ id: "max", label: "Max", isDefault: true }],
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
    },
    {
      id: "contextWindow",
      label: "Context window",
      type: "select",
      options: [{ id: "1m", label: "1M", isDefault: true }],
    },
    {
      id: "reasoning",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ],
    },
    { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
  ]),
  model("gpt-next", [
    {
      id: "reasoning",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
      ],
    },
    { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
  ]),
] satisfies ReadonlyArray<ServerProviderModel>;

const richValue: ProviderSessionDefault = {
  model: "gpt-rich",
  options: [
    { id: "reasoning", value: "high" },
    { id: "fastMode", value: false },
  ],
};

type Props = Parameters<typeof ProviderSessionDefaultsControls>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    driver: CODEX,
    models: richModels,
    value: richValue,
    disabled: false,
    onChange: vi.fn(),
    ...overrides,
  };
}

function render(props: Props): string {
  controls.reset();
  return renderToStaticMarkup(<ProviderSessionDefaultsControls {...props} />);
}

function entries(kind: "Select" | "Switch"): ReadonlyArray<Record<string, unknown>> {
  return controls.entries.filter((entry) => entry.kind === kind).map((entry) => entry.props);
}

function attributeValues(markup: string, attribute: string): ReadonlyArray<string> {
  return [...markup.matchAll(new RegExp(`\\s${attribute}="([^"]+)"`, "g"))].map(
    (match) => match[1]!,
  );
}

beforeEach(() => {
  controls.reset();
});

describe("ProviderSessionDefaultsControls", () => {
  it("renders accessible model, effort, and fast controls in order", () => {
    const markup = render(baseProps());

    expect(markup).toContain("Default model");
    expect(markup).toContain("Default effort");
    expect(markup).toContain("Fast by default");
    expect(controls.entries.map((entry) => entry.kind)).toEqual(["Select", "Select", "Switch"]);
    expect(markup).toContain('aria-label="Default model"');
    expect(markup).toContain('aria-label="Default effort"');
    expect(attributeValues(markup, "for")).toEqual(attributeValues(markup, "id"));
    expect(entries("Switch")[0]?.["aria-label"]).toBe("Fast by default");
  });

  it("gives each rendered defaults row unique control ids and local label targets", () => {
    const markup = renderToStaticMarkup(
      <>
        <section data-row="first">
          <ProviderSessionDefaultsControls {...baseProps()} />
        </section>
        <section data-row="second">
          <ProviderSessionDefaultsControls {...baseProps()} />
        </section>
      </>,
    );
    const firstRow = markup.match(/<section data-row="first">([\s\S]*?)<\/section>/)?.[1];
    const secondRow = markup.match(/<section data-row="second">([\s\S]*?)<\/section>/)?.[1];

    expect(firstRow).toBeDefined();
    expect(secondRow).toBeDefined();

    const firstIds = attributeValues(firstRow!, "id");
    const secondIds = attributeValues(secondRow!, "id");
    const allIds = [...firstIds, ...secondIds];

    expect(new Set(allIds)).toHaveLength(allIds.length);
    expect(attributeValues(firstRow!, "for").every((id) => firstIds.includes(id))).toBe(true);
    expect(attributeValues(secondRow!, "for").every((id) => secondIds.includes(id))).toBe(true);
  });

  it("disables every available control when the provider is disabled", () => {
    render(baseProps({ disabled: true }));

    expect(entries("Select").every((entry) => entry.disabled === true)).toBe(true);
    expect(entries("Switch")[0]?.disabled).toBe(true);
  });

  it("omits effort and fast controls when the selected model does not support them", () => {
    const markup = render(
      baseProps({
        driver: OPENCODE,
        models: [
          model("plain", [
            {
              id: "variant",
              label: "Variant",
              type: "select",
              options: [{ id: "max", label: "Max", isDefault: true }],
            },
            {
              id: "agent",
              label: "Agent",
              type: "select",
              options: [{ id: "build", label: "Build", isDefault: true }],
            },
            {
              id: "contextWindow",
              label: "Context window",
              type: "select",
              options: [{ id: "1m", label: "1M", isDefault: true }],
            },
          ]),
        ],
        value: { model: "plain" },
      }),
    );

    expect(markup).toContain("Default model");
    expect(markup).not.toContain("Default effort");
    expect(markup).not.toContain("Fast by default");
    expect(controls.entries.map((entry) => entry.kind)).toEqual(["Select"]);
  });

  it("keeps the complete Codex row and values mounted when discovery becomes empty", () => {
    const value: ProviderSessionDefault = {
      model: "gpt-rich",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    };
    const codexModels = [
      model("gpt-rich", [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
        {
          id: "serviceTier",
          label: "Service tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "fast", label: "Fast" },
          ],
          currentValue: "default",
        },
      ]),
    ];
    const richMarkup = render(baseProps({ models: codexModels, value }));
    const richKinds = controls.entries.map((entry) => entry.kind);
    const emptyMarkup = render(baseProps({ models: [], value }));
    const emptyKinds = controls.entries.map((entry) => entry.kind);

    expect(richMarkup).toContain("Default effort");
    expect(emptyMarkup).toContain("Default effort");
    expect(emptyMarkup).toContain("Fast by default");
    expect(emptyKinds).toEqual(richKinds);
    expect(emptyKinds).toEqual(["Select", "Select", "Switch"]);
    expect(entries("Select")[1]?.value).toBe("high");
    expect(entries("Switch")[0]?.checked).toBe(true);
  });

  it("changes only interactivity when Codex is disabled and re-enabled", () => {
    render(baseProps({ disabled: true }));
    const disabledShape = controls.entries.map((entry) => entry.kind);

    expect(controls.entries.every((entry) => entry.props.disabled === true)).toBe(true);

    render(baseProps({ disabled: false }));

    expect(controls.entries.map((entry) => entry.kind)).toEqual(disabledShape);
    expect(controls.entries.every((entry) => entry.props.disabled === false)).toBe(true);
  });

  it("keeps an unavailable saved model selectable so the user can recover", () => {
    const markup = render(
      baseProps({
        models: [richModels[0]!],
        value: { model: "private-model" },
      }),
    );

    expect(markup).toContain("private-model");
    expect(markup).toContain("Unavailable here; new sessions will use gpt-rich.");
    expect(entries("Select")[0]).toMatchObject({ disabled: false, value: "private-model" });
  });

  it("selects the resolved live model for a saved model alias", () => {
    render(
      baseProps({
        models: [model("gpt-5.4")],
        value: { model: "gpt-5-codex" },
      }),
    );

    expect(entries("Select")[0]).toMatchObject({ disabled: false, value: "gpt-5.4" });
  });

  it("emits model, effort, and fast changes using provider-native option ids", () => {
    const onChange = vi.fn();
    render(baseProps({ onChange }));
    const [modelSelect, effortSelect] = entries("Select");
    const [fastSwitch] = entries("Switch");

    (modelSelect!.onValueChange as (value: string | null) => void)("gpt-next");
    (effortSelect!.onValueChange as (value: string | null) => void)("low");
    (fastSwitch!.onCheckedChange as (checked: boolean) => void)(true);

    expect(onChange).toHaveBeenNthCalledWith(1, {
      model: "gpt-next",
      options: [
        { id: "reasoning", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      model: "gpt-rich",
      options: [
        { id: "reasoning", value: "low" },
        { id: "fastMode", value: false },
      ],
    });
    expect(onChange).toHaveBeenNthCalledWith(3, {
      model: "gpt-rich",
      options: [
        { id: "reasoning", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });
});
