"use client";

import { ThemeProvider } from "../providers/theme-provider";
import { AuthGate } from "../components/auth-gate";
import { AppSidebar } from "../components/app-sidebar";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "../components/ui/sidebar";
import { Separator } from "../components/ui/separator";
import { AppBreadcrumbs } from "../components/breadcrumbs";
import { Web3Provider } from "../providers/web3-provider";
import { usePathname } from "next/navigation";
import { useAuthStore } from "../stores/auth-store";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const session = useAuthStore((s) => s.session);

    // Show ONLY the landing page, no sidebar/layout, if on /landing and not authenticated
    if (pathname === "/landing" && !session) {
        return <ThemeProvider>{children}</ThemeProvider>;
    } else if (pathname?.startsWith('/watch/')) {
        // Overlay route: render minimal shell without sidebar/auth gate.
        return (
            <Web3Provider>
                <ThemeProvider>
                    {children}
                </ThemeProvider>
            </Web3Provider>
        );
    } else {

        return (
            <Web3Provider>
                <ThemeProvider>
                    <AuthGate />
                    <SidebarProvider>
                        <AppSidebar />
                        <SidebarInset>
                            <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
                                <div className="flex items-center gap-2 px-4">
                                    <SidebarTrigger className="-ml-1" />
                                    <Separator
                                        orientation="vertical"
                                        className="mr-2 data-[orientation=vertical]:h-4"
                                    />
                                    <AppBreadcrumbs />
                                </div>
                            </header>
                            <div className="min-h-[calc(100dvh-64px)]">{children}</div>
                        </SidebarInset>
                    </SidebarProvider>
                </ThemeProvider>
            </Web3Provider>
        );
    }
}
