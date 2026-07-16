import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ChatRouteInset } from "./-ChatRouteInset";

describe("ChatRouteInset", () => {
  it("inherits the shell height without claiming the viewport", () => {
    const markup = renderToStaticMarkup(
      <ChatRouteInset>
        <div>chat</div>
      </ChatRouteInset>,
    );

    expect(markup).toContain("h-full");
    expect(markup).toContain("min-h-0");
    expect(markup).toContain("overflow-hidden");
    expect(markup).not.toContain("h-svh");
    expect(markup).not.toContain("h-dvh");
  });
});
