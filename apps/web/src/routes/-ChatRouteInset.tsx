import type { PropsWithChildren } from "react";

import { SidebarInset } from "~/components/ui/sidebar";

export function ChatRouteInset({ children }: PropsWithChildren) {
  return (
    <SidebarInset className="h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {children}
    </SidebarInset>
  );
}
