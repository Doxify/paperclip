import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { MessageCircle, Bot } from "lucide-react";
import type { Agent, IssueComment } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { directivesApi } from "../api/directives";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Identity } from "../components/Identity";
import { LiveRunWidget } from "../components/LiveRunWidget";
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

function MessageCard({
  comment,
  agentMap,
}: {
  comment: IssueComment;
  agentMap: Map<string, Agent>;
}) {
  const isAgent = !!comment.authorAgentId;
  const agent = comment.authorAgentId ? agentMap.get(comment.authorAgentId) : null;

  return (
    <div className="border border-border bg-background p-3 rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <div>
          {isAgent ? (
            agent ? (
              <Link to={`/agents/${agent.id}`} className="hover:underline">
                <Identity name={agent.name} size="sm" />
              </Link>
            ) : (
              <Identity name={comment.authorAgentId?.slice(0, 8) ?? "Agent"} size="sm" />
            )
          ) : (
            <Identity name="You" size="sm" />
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {new Date(comment.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <MarkdownBody>{comment.body}</MarkdownBody>
    </div>
  );
}

export function CeoChat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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

  const reversedComments = useMemo(
    () => (comments ? [...comments].reverse() : []),
    [comments],
  );

  const sendMessage = useMutation({
    mutationFn: (text: string) => directivesApi.sendMessage(selectedCompanyId!, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(thread?.id ?? "") });
      queryClient.invalidateQueries({ queryKey: queryKeys.directives.thread(selectedCompanyId!) });
    },
  });

  const handleSend = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || sendMessage.isPending) return;
    setBody("");
    if (selectedCompanyId) clearDraft(selectedCompanyId);
    await sendMessage.mutateAsync(trimmed);
  }, [body, sendMessage, selectedCompanyId]);

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a company to start chatting.
      </div>
    );
  }

  if (threadLoading) return <PageSkeleton variant="list" />;

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
            </>
          )}
        </div>
      </div>

      {/* Scrollable content: input + live widget + messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-2xl space-y-3">
          {/* Input area */}
          <div className="border border-border bg-background rounded-lg p-3">
            <MarkdownEditor
              value={body}
              onChange={setBody}
              placeholder="Type a directive..."
              onSubmit={handleSend}
              contentClassName="min-h-[60px] max-h-[200px]"
            />
            <div className="flex justify-end mt-2">
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!body.trim() || sendMessage.isPending}
              >
                Send
              </Button>
            </div>
          </div>

          {/* Live agent output */}
          {thread && <LiveRunWidget issueId={thread.id} companyId={thread.companyId} />}

          {/* Messages (newest first) */}
          {reversedComments.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground gap-2">
              <MessageCircle className="h-8 w-8" />
              <p>Send a message to your CEO agent.</p>
              <p className="text-xs">Your messages become directives the CEO will act on.</p>
            </div>
          )}
          {reversedComments.map((comment) => (
            <MessageCard key={comment.id} comment={comment} agentMap={agentMap} />
          ))}
        </div>
      </div>
    </div>
  );
}
