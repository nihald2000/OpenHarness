import { ChatView } from "@/components/chat-view";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  return <ChatView key={decoded} sessionId={decoded} />;
}
