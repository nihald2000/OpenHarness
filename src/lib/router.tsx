import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";

interface RouterContextValue {
  pathname: string;
  search: string;
  push: (href: string) => void;
  replace: (href: string) => void;
}

const RouterContext = createContext<RouterContextValue | null>(null);

function getNormalizedPath(): { pathname: string; search: string } {
  if (typeof window === "undefined") {
    return { pathname: "/", search: "" };
  }
  // Check hash first if hash routing is used (e.g., #/c/123 or #/settings)
  const hash = window.location.hash;
  if (hash.startsWith("#/")) {
    const [pathPart, queryPart] = hash.slice(1).split("?");
    return { pathname: pathPart || "/", search: queryPart ? `?${queryPart}` : "" };
  }
  return {
    pathname: window.location.pathname || "/",
    search: window.location.search || "",
  };
}

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [loc, setLoc] = useState(getNormalizedPath);

  useEffect(() => {
    const handlePopState = () => {
      setLoc(getNormalizedPath());
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hashchange", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hashchange", handlePopState);
    };
  }, []);

  const push = useCallback((href: string) => {
    if (href.startsWith("#")) {
      window.location.hash = href;
      setLoc(getNormalizedPath());
      return;
    }
    window.history.pushState(null, "", href);
    setLoc(getNormalizedPath());
  }, []);

  const replace = useCallback((href: string) => {
    if (href.startsWith("#")) {
      window.location.hash = href;
      setLoc(getNormalizedPath());
      return;
    }
    window.history.replaceState(null, "", href);
    setLoc(getNormalizedPath());
  }, []);

  const value = useMemo(
    () => ({
      pathname: loc.pathname,
      search: loc.search,
      push,
      replace,
    }),
    [loc.pathname, loc.search, push, replace]
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    return {
      push: (href: string) => {
        if (typeof window !== "undefined") {
          window.history.pushState(null, "", href);
        }
      },
      replace: (href: string) => {
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", href);
        }
      },
      pathname: typeof window !== "undefined" ? window.location.pathname : "/",
    };
  }
  return ctx;
}

export function usePathname() {
  const ctx = useContext(RouterContext);
  return ctx ? ctx.pathname : typeof window !== "undefined" ? window.location.pathname : "/";
}

export function Link({
  href,
  children,
  className,
  onClick,
  target,
  rel,
  title,
  "aria-current": ariaCurrent,
  "aria-label": ariaLabel,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  target?: string;
  rel?: string;
  title?: string;
  "aria-current"?: "page" | "step" | "location" | "date" | "time" | "true" | "false" | boolean;
  "aria-label"?: string;
}) {
  const router = useRouter();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (target === "_blank" || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
      return;
    }
    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
      return;
    }
    e.preventDefault();
    router.push(href);
  };

  return (
    <a
      href={href}
      className={className}
      onClick={handleClick}
      target={target}
      rel={rel}
      title={title}
      aria-current={ariaCurrent}
      aria-label={ariaLabel}
    >
      {children}
    </a>
  );
}
