import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarBrandContent } from "./Sidebar";

describe("SidebarBrandContent", () => {
  it("renders the configured app base name and stage", () => {
    const markup = renderToStaticMarkup(
      <SidebarBrandContent appBaseName="T4Code" stageLabel="Dev" />,
    );

    expect(markup).toContain(">T4Code<");
    expect(markup).toContain(">Dev<");
  });
});
