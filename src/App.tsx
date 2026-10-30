import { RouterProvider, usePathname } from "@/lib/router";
import { AppShell } from "@/components/app-shell";
import { ChatView } from "@/components/chat-view";
import { SettingsView } from "@/components/settings/settings-view";
import { SignInCard } from "@/components/settings/sign-in";

function AppRoutes() {
  const pathname = usePathname();

  if (pathname === "/settings") {
    return <SettingsView />;
  }

  if (pathname === "/login") {
    return (
      <div className="flex h-full min-h-screen items-center justify-center p-6 bg-bg">
        <SignInCard />
      </div>
    );
  }

  if (pathname.startsWith("/c/")) {
    const rawId = pathname.slice(3);
    const sessionId = decodeURIComponent(rawId);
    return <ChatView key={sessionId} sessionId={sessionId} />;
  }

  // Root or any other route
  return <ChatView key="new" />;
}

export function App() {
  return (
    <RouterProvider>
      <AppShell>
        <AppRoutes />
      </AppShell>
    </RouterProvider>
  );
}

export default App;
