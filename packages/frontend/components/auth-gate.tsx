"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "../stores/auth-store";

// Centralized client-side auth gate: redirects to /auth when unauthenticated on protected routes,
// and redirects to /dashboard when authenticated on /auth or /signup.
export function AuthGate() {
  const pathname = usePathname();
  const router = useRouter();
  const session = useAuthStore((s) => s.session);

  useEffect(() => {
    if (!pathname) return;
    const isPublic =
      pathname === "/landing" ||
      pathname === "/signup" ||
      pathname.startsWith("/auth") ||
      // Overlay should be publicly accessible (no auth redirect)
      pathname.startsWith("/watch/");

    // If unauthenticated and route is not public, redirect to /landing
    if (!session && !isPublic) {
      if (pathname !== "/landing") router.replace("/landing");
      return;
    }

    // If authenticated and on auth-only or landing routes, land on dashboard
    if (session && (pathname.startsWith("/auth") || pathname === "/signup" || pathname === "/landing")) {
      if (pathname !== "/dashboard") router.replace("/dashboard");
      return;
    }

    // Note: /streamer is allowed for any authenticated user; the page itself shows
    // a CTA to become a creator if the role isn't STREAMER/ADMIN. Keeping this here
    // avoids a redirect loop and matches the page flow.
  }, [pathname, router, session]);

  return null;
}
