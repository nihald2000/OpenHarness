import type { Metadata } from "next";
import { SignInCard } from "@/components/settings/sign-in";
import { safeReturnTo } from "@/lib/oauth";

export const metadata: Metadata = { title: "Sign in - OpenHarness" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string; error?: string }> }) {
  const params = await searchParams;
  return <SignInCard returnTo={safeReturnTo(params.returnTo)} initialError={params.error} />;
}
