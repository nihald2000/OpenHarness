import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignInCard } from "@/components/settings/sign-in";
import { authDisabled } from "@/lib/auth-mode";
import { safeReturnTo } from "@/lib/oauth";

export const metadata: Metadata = { title: "Sign in - OpenHarness" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string; error?: string }> }) {
  if (authDisabled()) redirect("/");
  const params = await searchParams;
  return <SignInCard returnTo={safeReturnTo(params.returnTo)} initialError={params.error} />;
}
