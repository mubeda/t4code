import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./sidebar";
import { resolveSidebarState } from "./sidebarState";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  it("uses mobile sheet visibility for the shared responsive state", () => {
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
  });

  it("exposes collapsed state for shared titlebar inset styling", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <div />
      </SidebarProvider>,
    );

    expect(html).toContain('data-sidebar-state="collapsed"');
  });

  it("keeps the sidebar trigger interactive inside Electron drag regions", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain("[-webkit-app-region:no-drag]");
    expect(html).toContain("size-[var(--workspace-titlebar-control-size)]!");
  });

  it("uses a pointer cursor for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });
});

describe("simple sidebar slots render their data-slot markers", () => {
  it("renders the header, footer, and separator", () => {
    expect(renderToStaticMarkup(<SidebarHeader>head</SidebarHeader>)).toContain(
      'data-slot="sidebar-header"',
    );
    expect(renderToStaticMarkup(<SidebarFooter>foot</SidebarFooter>)).toContain(
      'data-slot="sidebar-footer"',
    );
    expect(renderToStaticMarkup(<SidebarSeparator />)).toContain(
      'data-slot="sidebar-separator"',
    );
  });

  it("renders the scrollable content region", () => {
    const html = renderToStaticMarkup(
      <SidebarContent className="custom-content">body</SidebarContent>,
    );
    expect(html).toContain('data-slot="sidebar-content"');
    expect(html).toContain("custom-content");
    expect(html).toContain(">body</div>");
  });

  it("renders the group, group label, group action, and group content", () => {
    expect(renderToStaticMarkup(<SidebarGroup>g</SidebarGroup>)).toContain(
      'data-slot="sidebar-group"',
    );
    expect(
      renderToStaticMarkup(<SidebarGroupLabel>Projects</SidebarGroupLabel>),
    ).toContain('data-slot="sidebar-group-label"');
    expect(
      renderToStaticMarkup(<SidebarGroupAction aria-label="Add">+</SidebarGroupAction>),
    ).toContain('data-slot="sidebar-group-action"');
    expect(
      renderToStaticMarkup(<SidebarGroupContent>content</SidebarGroupContent>),
    ).toContain('data-slot="sidebar-group-content"');
  });

  it("renders a group label through a custom render element", () => {
    const html = renderToStaticMarkup(
      <SidebarGroupLabel render={<a href="/x" />}>Linked</SidebarGroupLabel>,
    );
    expect(html).toContain("<a");
    expect(html).toContain('data-slot="sidebar-group-label"');
    expect(html).toContain("Linked");
  });

  it("renders the menu, menu item, and menu badge", () => {
    expect(renderToStaticMarkup(<SidebarMenu>m</SidebarMenu>)).toContain(
      'data-slot="sidebar-menu"',
    );
    expect(renderToStaticMarkup(<SidebarMenuItem>i</SidebarMenuItem>)).toContain(
      'data-slot="sidebar-menu-item"',
    );
    expect(renderToStaticMarkup(<SidebarMenuBadge>3</SidebarMenuBadge>)).toContain(
      'data-slot="sidebar-menu-badge"',
    );
  });

  it("renders the submenu, submenu item, and input", () => {
    expect(renderToStaticMarkup(<SidebarMenuSub>s</SidebarMenuSub>)).toContain(
      'data-slot="sidebar-menu-sub"',
    );
    expect(renderToStaticMarkup(<SidebarMenuSubItem>si</SidebarMenuSubItem>)).toContain(
      'data-slot="sidebar-menu-sub-item"',
    );
    expect(renderToStaticMarkup(<SidebarInput placeholder="Search" />)).toContain(
      'data-slot="sidebar-input"',
    );
  });

  it("renders the inset main region", () => {
    const html = renderToStaticMarkup(<SidebarInset>main</SidebarInset>);
    expect(html).toContain('data-slot="sidebar-inset"');
    expect(html).toContain("<main");
  });

  it("renders a menu action that only appears on hover when requested", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction showOnHover aria-label="More">
        <span>...</span>
      </SidebarMenuAction>,
    );
    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("md:opacity-0");
  });

  it("renders a skeleton row with an icon and a deterministic width", () => {
    const html = renderToStaticMarkup(<SidebarMenuSkeleton showIcon />);
    expect(html).toContain('data-slot="sidebar-menu-skeleton"');
    expect(html).toContain('data-sidebar="menu-skeleton-icon"');
    expect(html).toContain("--skeleton-width");
  });

  it("renders a skeleton row without an icon", () => {
    const html = renderToStaticMarkup(<SidebarMenuSkeleton />);
    expect(html).toContain('data-slot="sidebar-menu-skeleton"');
    expect(html).not.toContain('data-sidebar="menu-skeleton-icon"');
  });

  it("marks an active submenu button", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton isActive size="sm" render={<button type="button" />}>
        Active
      </SidebarMenuSubButton>,
    );
    expect(html).toContain('data-active="true"');
    expect(html).toContain('data-size="sm"');
  });
});

describe("SidebarMenuButton variants and tooltip", () => {
  it("applies the outline variant and large size data attributes", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuButton variant="outline" size="lg" isActive>
          Repo
        </SidebarMenuButton>
      </SidebarProvider>,
    );
    expect(html).toContain('data-size="lg"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain("bg-background");
  });

  it("wraps the button in a tooltip when a string tooltip is provided", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuButton tooltip="Helpful hint">Repo</SidebarMenuButton>
      </SidebarProvider>,
    );
    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("Repo");
  });

  it("wraps the button in a tooltip when an object tooltip is provided", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuButton tooltip={{ children: "Object hint" }}>Repo</SidebarMenuButton>
      </SidebarProvider>,
    );
    expect(html).toContain('data-slot="sidebar-menu-button"');
  });
});

describe("Sidebar container variants (desktop SSR)", () => {
  it("renders the non-collapsible variant as a plain flex column", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar collapsible="none">inner</Sidebar>
      </SidebarProvider>,
    );
    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain(">inner<");
    // The gap/container scaffolding only exists for the collapsible desktop shell.
    expect(html).not.toContain('data-slot="sidebar-gap"');
  });

  it("renders the offcanvas desktop shell with gap and container slots", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar>shell</Sidebar>
      </SidebarProvider>,
    );
    expect(html).toContain('data-slot="sidebar-gap"');
    expect(html).toContain('data-slot="sidebar-container"');
    expect(html).toContain('data-slot="sidebar-inner"');
    expect(html).toContain('data-side="left"');
  });

  it("applies floating variant padding classes", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar variant="floating" side="right">
          f
        </Sidebar>
      </SidebarProvider>,
    );
    expect(html).toContain('data-variant="floating"');
    expect(html).toContain('data-side="right"');
  });

  it("applies inset variant classes", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar variant="inset">i</Sidebar>
      </SidebarProvider>,
    );
    expect(html).toContain('data-variant="inset"');
  });

  it("reflects the collapsed collapsible marker when the sidebar starts closed", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="icon">c</Sidebar>
      </SidebarProvider>,
    );
    expect(html).toContain('data-collapsible="icon"');
    expect(html).toContain('data-state="collapsed"');
  });
});

describe("useSidebar / useSidebarVisibility hooks", () => {
  it("throws when useSidebar is read outside of a provider", () => {
    function Consumer() {
      useSidebar();
      return null;
    }
    expect(() => renderToStaticMarkup(<Consumer />)).toThrow(
      /useSidebar must be used within a SidebarProvider/,
    );
  });

  it("reports desktop visibility from the open flag", () => {
    function Probe() {
      return <span>{String(useSidebarVisibility())}</span>;
    }
    expect(
      renderToStaticMarkup(
        <SidebarProvider defaultOpen>
          <Probe />
        </SidebarProvider>,
      ),
    ).toContain(">true<");
    expect(
      renderToStaticMarkup(
        <SidebarProvider defaultOpen={false}>
          <Probe />
        </SidebarProvider>,
      ),
    ).toContain(">false<");
  });

  it("keeps the controlled-open value when a parent owns the state", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider open onOpenChange={() => undefined}>
        <Sidebar>controlled</Sidebar>
      </SidebarProvider>,
    );
    expect(html).toContain('data-sidebar-state="expanded"');
  });
});
