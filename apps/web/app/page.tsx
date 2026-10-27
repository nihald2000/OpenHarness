import { ChatView } from "@/components/chat-view";

export default async function HomePage({
  params,
}: {
  params: Promise<Record<string, string>>;
}) {
  await params;
  return <ChatView key="new" />;
}
