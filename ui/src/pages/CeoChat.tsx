import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Send, MessageCircle, Bot } from "lucide-react";
import type { Agent, IssueComment } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { directivesApi } from "../api/directives";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "../components/MarkdownBody";
import { Identity } from "../components/Identity";
import { getAgentIcon } from "../components/AgentIconPicker";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";

const DRAFT_KEY_PREFIX = "paperclip:directive-draft:";
const DRAFT_DEBOUNCE_MS = 800;

function loadDraft(companyId: string): string {
  try {
    return localStorage.getItem(`${DRAFT_KEY_PREFIX}${companyId}`) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(companyId: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(`${DRAFT_KEY_PREFIX}${companyId}`, value);
    } else {
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${companyId}`);
    }
  } catch {
    /* ignore */
  }
}

function clearDraft(companyId: string) {
  try {
    localStorage.removeItem(`${DRAFT_KEY_PREFIX}${companyId}`);
  } catch {
    /* ignore */
  }
}

function AgentStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-500/15 text-green-700 dark:text-green-400",
    running: "bg-green-500/15 text-green-700 dark:text-green-400",
    idle: "bg-muted text-muted-foreground",
    paused: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
    error: "bg-red-500/15 text-red-700 dark:text-red-400",
    pending_approval: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  };

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? colors.idle}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function MessageBubble({
  comment,
  agentMap,
}: {
  comment: IssueComment;
  agentMap: Map<string, Agent>;
}) {
  const isAgent = !!comment.authorAgentId;
  const agent = comment.authorAgentId ? agentMap.get(comment.authorAgentId) : null;

  return (
    <div className={`flex gap-3 ${isAgent ? "" : "flex-row-reverse"}`}>
      <div className="shrink-0 mt-1">
        {isAgent ? (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
            {(() => {
              const Icon = getAgentIcon(agent?.icon);
              return <Icon className="h-4 w-4 text-muted-foreground" />;
            })()}
          </div>
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
            You
          </div>
        )}
      </div>
      <div className={`max-w-[75%] min-w-0 ${isAgent ? "" : "text-right"}`}>
        <div className="mb-1 text-xs text-muted-foreground">
          {isAgent ? (
            agent ? (
              <Link to={`/agents/${agent.id}`} className="hover:underline font-medium">
                {agent.name}
              </Link>
            ) : (
              comment.authorAgentId?.slice(0, 8)
            )
          ) : (
            "You"
          )}
          <span className="ml-2">
            {new Date(comment.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <div className={`rounded-lg px-3 py-2 text-sm ${isAgent ? "bg-muted" : "bg-primary/10"}`}>
          <MarkdownBody>{comment.body}</MarkdownBody>
        </div>
      </div>
    </div>
  );
}

export function CeoChat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setBreadcrumbs([{ label: "Chat" }]);
  }, [setBreadcrumbs]);

  // Load draft
  useEffect(() => {
    if (!selectedCompanyId) return;
    setBody(loadDraft(selectedCompanyId));
  }, [selectedCompanyId]);

  // Save draft with debounce
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(selectedCompanyId, body);
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [body, selectedCompanyId]);

  const { data: thread, isLoading: threadLoading, error: threadError } = useQuery({
    queryKey: queryKeys.directives.thread(selectedCompanyId!),
    queryFn: () => directivesApi.getThread(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: (count, error) => {
      // Don't retry 404 (no CEO agent)
      if (error && "status" in error && (error as { status: number }).status === 404) return false;
      return count < 2;
    },
  });

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(thread?.id ?? ""),
    queryFn: () => issuesApi.listComments(thread!.id),
    enabled: !!thread?.id,
  });

  const { data: agentsList } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    agentsList?.forEach((a) => map.set(a.id, a));
    return map;
  }, [agentsList]);

  const ceoAgent = useMemo(
    () => agentsList?.find((a) => a.role === "ceo" && !a.reportsTo) ?? null,
    [agentsList],
  );

  const sendMessage = useMutation({
    mutationFn: (text: string) => directivesApi.sendMessage(selectedCompanyId!, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(thread?.id ?? "") });
      queryClient.invalidateQueries({ queryKey: queryKeys.directives.thread(selectedCompanyId!) });
    },
  });

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [comments]);

  const handleSend = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || sendMessage.isPending) return;
    setBody("");
    if (selectedCompanyId) clearDraft(selectedCompanyId);
    await sendMessage.mutateAsync(trimmed);
  }, [body, sendMessage, selectedCompanyId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [body]);

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a company to start chatting.
      </div>
    );
  }

  if (threadLoading) return <PageSkeleton variant="list" />;

  // No CEO agent
  const is404 = threadError && "status" in threadError && (threadError as { status: number }).status === 404;
  if (is404 || (!threadLoading && !thread && !threadError)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-sm text-muted-foreground">
        <Bot className="h-10 w-10" />
        <p>No CEO agent found.</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/agents/new">Create a CEO Agent</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Chat with CEO</h1>
          {ceoAgent && (
            <>
              <span className="text-muted-foreground">·</span>
              <Link to={`/agents/${ceoAgent.id}`} className="text-sm text-muted-foreground hover:underline">
                {ceoAgent.name}
              </Link>
              <AgentStatusBadge status={ceoAgent.status} />
            </>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-2xl space-y-4">
          {(!comments || comments.length === 0) && (
            <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground gap-2">
              <MessageCircle className="h-8 w-8" />
              <p>Send a message to your CEO agent.</p>
              <p className="text-xs">Your messages become directives the CEO will act on.</p>
            </div>
          )}
          {comments?.map((comment) => (
            <MessageBubble key={comment.id} comment={comment} agentMap={agentMap} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border px-4 py-3 shrink-0">
        <div className="mx-auto max-w-2xl flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a directive..."
            rows={1}
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!body.trim() || sendMessage.isPending}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
