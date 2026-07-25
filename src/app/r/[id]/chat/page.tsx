import { ChatPanel } from '@/features/chat/chat-panel';
import { analysisName, loadAnalysis } from '@/features/report/load';

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);

  return (
    <section className="mt-8">
      <h2 className="text-heading text-ink">Ask the codebase</h2>
      <p className="text-ink-muted mt-1.5 max-w-2xl text-sm leading-relaxed">
        Questions are answered from this repository’s own indexed source. Answers stream, cite the
        files they used, and those citations are clickable.
      </p>

      <ChatPanel analysisId={id} repoName={analysisName(analysis)} />
    </section>
  );
}
