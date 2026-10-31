import { Link } from "@/lib/router";
import { useCatalog } from "@/lib/hooks";
import { BrandLogo } from "./ui";

export function EmptyState() {
  const { models, loading } = useCatalog();
  const needsConfiguration = !loading && models.length === 0;

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-[560px] text-center animate-fade-in">
        <div className="mx-auto mb-4 flex items-center justify-center">
          <BrandLogo className="size-10" />
        </div>
        <h1 className="text-[28px] font-semibold tracking-tight text-fg">
          OpenHarness
        </h1>
        {loading ? (
          <p className="mx-auto mt-3 max-w-lg text-sm leading-normal text-muted" role="status">
            Loading model configuration…
          </p>
        ) : needsConfiguration ? (
          <div className="mx-auto mt-4 max-w-lg rounded-xl border border-border bg-elev p-5">
            <h2 className="text-sm font-semibold text-fg">
              Configure a model to start
            </h2>
            <p className="mt-2 text-sm leading-normal text-muted">
              No model provider is configured. Add a provider and choose its
              model in Settings before starting a chat.
            </p>
            <Link
              href="/settings"
              className="mt-4 inline-flex h-9 items-center justify-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-strong"
            >
              Open model settings
            </Link>
          </div>
        ) : (
          <p className="mx-auto mt-3 max-w-lg text-sm leading-normal text-muted">
            Start a conversation by describing what you need in the message box.
          </p>
        )}
      </div>
    </div>
  );
}
