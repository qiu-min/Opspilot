import { Plus, Sparkles, UserRound } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { ConversationSummary } from "./types";

type ConversationGroupKey = "today" | "yesterday" | "previous-7-days";

type ConversationSidebarProps = {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onConversationSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  accountEmail: string;
  environmentLabel: string;
  mobile?: boolean;
};

const conversationGroups: Array<{ key: ConversationGroupKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "previous-7-days", label: "Previous 7 days" },
];

function getConversationGroup(updatedAt: string): ConversationGroupKey {
  const updatedDate = new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) return "previous-7-days";

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const updatedStart = new Date(updatedDate.getFullYear(), updatedDate.getMonth(), updatedDate.getDate()).getTime();
  const daysSinceUpdate = Math.floor((todayStart - updatedStart) / 86_400_000);

  if (daysSinceUpdate <= 0) return "today";
  if (daysSinceUpdate === 1) return "yesterday";
  return "previous-7-days";
}

function getGroupedConversations(conversations: ConversationSummary[]) {
  return conversationGroups
    .map((group) => ({
      ...group,
      conversations: conversations
        .filter((conversation) => getConversationGroup(conversation.updatedAt) === group.key)
        .sort((left, right) => {
          const leftTime = new Date(left.updatedAt).getTime();
          const rightTime = new Date(right.updatedAt).getTime();
          return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
        }),
    }))
    .filter((group) => group.conversations.length > 0);
}

export function ConversationSidebar({ conversations, activeConversationId, onConversationSelect, onNewConversation, accountEmail, environmentLabel, mobile = false }: ConversationSidebarProps) {
  const groupedConversations = getGroupedConversations(conversations);

  return (
    <aside className={mobile ? "flex h-full w-full shrink-0 flex-col bg-navy text-white" : "hidden w-[256px] shrink-0 flex-col border-r border-white/10 bg-navy text-white lg:flex"} aria-label="Conversation sidebar">
      <div className="flex h-16 shrink-0 items-center border-b border-white/10 px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-navy shadow-sm" aria-hidden="true"><Sparkles size={16} strokeWidth={2.3} /></div>
          <span className="text-[15px] font-bold tracking-[-0.02em]">opspilot</span>
        </div>
      </div>

      <div className="px-4 pt-5">
        <Button variant="primary" size="md" className="w-full justify-start bg-accent/95" onClick={onNewConversation} aria-label="Start a new conversation">
          <Plus size={17} strokeWidth={2.4} aria-hidden="true" />
          New conversation
        </Button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-6" aria-label="Conversation history">
        <p className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-navy-muted/75">Conversation history</p>
        <div className="space-y-5">
          {groupedConversations.map((group) => (
            <section key={group.key} aria-labelledby={`conversation-group-${group.key}`}>
              <h2 id={`conversation-group-${group.key}`} className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-navy-muted/75">{group.label}</h2>
              <div className="space-y-0.5">
                {group.conversations.map((conversation) => {
                  const isActive = conversation.id === activeConversationId;

                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => onConversationSelect(conversation.id)}
                      className={`flex min-h-10 w-full cursor-pointer items-center rounded-lg px-3 text-left text-xs transition duration-200 ease-snappy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${isActive ? "bg-white/[0.12] font-semibold text-white" : "text-navy-muted hover:bg-white/[0.08] hover:text-white"}`}
                      aria-current={isActive ? "page" : undefined}
                      title={conversation.title}
                    >
                      <span className="min-w-0 truncate">{conversation.title}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </nav>

      <div className="shrink-0 border-t border-white/10 p-4">
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-white/[0.06] px-3 py-2.5">
          <span className="relative flex h-2 w-2" aria-hidden="true"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4ade80] opacity-50 motion-reduce:animate-none" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[#4ade80]" /></span>
          <span className="text-xs text-navy-muted">{environmentLabel}</span>
        </div>
        <div className="flex min-h-11 items-center gap-3 rounded-lg px-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#dce7f6] text-navy" aria-hidden="true"><UserRound size={15} /></span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold text-white" title={accountEmail}>{accountEmail}</p>
            <p className="mt-0.5 text-[10px] text-navy-muted">Account</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
