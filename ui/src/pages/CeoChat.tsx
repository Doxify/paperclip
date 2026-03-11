import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { MessageCircle, Bot } from "lucide-react";
import type { Agent, IssueComment } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { directivesApi } from "../api/directives";
import { activityApi, type RunForIssue } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { Identity } from "../components/Identity";
import { LiveRunWidget } from "../components/LiveRunWidget";
import { StatusBadge } from "../components/StatusBadge";
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

interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
}

type TimelineItem =
  | { kind: "comment"; id: string; createdAtMs: number; comment: CommentWithRunMeta }
  | { kind: "run"; id: string; createdAtMs: number; run: RunForIssue };

function RunCard({ run, agentMap }: { run: RunForIssue; agentMap: Map<string, Agent> }) {
  return (
    <div className="border border-border bg-accent/20 p-3 overflow-hidden min-w-0 rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <Link to={`/agents/${run.agentId}`} className="hover:underline">
          <Identity name={agentMap.get(run.agentId)?.name ?? run.agentId.slice(0, 8)} size="sm" />
        </Link>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(run.startedAt ?? run.createdAt)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Run</span>
        <Link
          to={`/agents/${run.agentId}/runs/${run.runId}`}
          className="inline-flex items-center rounded-md border border-border bg-accent/40 px-2 py-1 font-mono text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
        >
          {run.runId.slice(0, 8)}
        </Link>
        <StatusBadge status={run.status} />
      </div>
    </div>
  );
}

function MessageCard({
  comment,
  agentMap,
}: {
  comment: CommentWithRunMeta;
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
          {formatDateTime(comment.createdAt)}
        </span>
      </div>
      <MarkdownBody>{comment.body}</MarkdownBody>
      {comment.runId && (
        <div className="mt-2 pt-2 border-t border-border/60">
          {comment.runAgentId ? (
            <Link
              to={`/agents/${comment.runAgentId}/runs/${comment.runId}`}
              className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              run {comment.runId.slice(0, 8)}
            </Link>
          ) : (
            <span className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
              run {comment.runId.slice(0, 8)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function CeoChat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  // Past runs linked to this thread
  const { data: linkedRuns } = useQuery({
    queryKey: queryKeys.issues.runs(thread?.id ?? ""),
    queryFn: () => activityApi.runsForIssue(thread!.id),
    enabled: !!thread?.id,
    refetchInterval: 5_000,
  });

  // Activity events (to link comments → runs)
  const { data: activity } = useQuery({
    queryKey: queryKeys.issues.activity(thread?.id ?? ""),
    queryFn: () => activityApi.forIssue(thread!.id),
    enabled: !!thread?.id,
  });

  // Live runs (to filter from timeline and avoid duplicates with LiveRunWidget)
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(thread?.id ?? ""),
    queryFn: () => heartbeatsApi.liveRunsForIssue(thread!.id),
    enabled: !!thread?.id,
    refetchInterval: 3000,
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(thread?.id ?? ""),
    queryFn: () => heartbeatsApi.activeRunForIssue(thread!.id),
    enabled: !!thread?.id,
    refetchInterval: 3000,
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

  // Enrich comments with run metadata
  const commentsWithRunMeta = useMemo(() => {
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
    const agentIdByRunId = new Map<string, string>();
    for (const run of linkedRuns ?? []) agentIdByRunId.set(run.runId, run.agentId);
    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
      });
    }
    return (comments ?? []).map((c) => {
      const meta = runMetaByCommentId.get(c.id);
      return meta ? { ...c, ...meta } : c;
    });
  }, [activity, comments, linkedRuns]);

  // Filter out runs already shown by LiveRunWidget
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>();
    for (const r of liveRuns ?? []) liveIds.add(r.id);
    if (activeRun) liveIds.add(activeRun.id);
    if (liveIds.size === 0) return linkedRuns ?? [];
    return (linkedRuns ?? []).filter((r) => !liveIds.has(r.runId));
  }, [linkedRuns, liveRuns, activeRun]);

  // Build merged timeline (oldest first)
  // For comments linked to a run, use the run's start time so they sort next to their run
  const timeline = useMemo(() => {
    const runStartByRunId = new Map<string, number>();
    for (const r of linkedRuns ?? [])
      runStartByRunId.set(r.runId, new Date(r.startedAt ?? r.createdAt).getTime());

    const items: TimelineItem[] = [];
    for (const c of commentsWithRunMeta) {
      // Place run-linked comments right after their run card (run timestamp + 1ms)
      const runStart = c.runId ? runStartByRunId.get(c.runId) : undefined;
      const ts = runStart != null ? runStart + 1 : new Date(c.createdAt).getTime();
      items.push({ kind: "comment", id: c.id, createdAtMs: ts, comment: c });
    }
    for (const r of timelineRuns)
      items.push({ kind: "run", id: r.runId, createdAtMs: new Date(r.startedAt ?? r.createdAt).getTime(), run: r });
    items.sort((a, b) => a.createdAtMs - b.createdAtMs); // oldest first
    return items;
  }, [commentsWithRunMeta, linkedRuns, timelineRuns]);

  const sendMessage = useMutation({
    mutationFn: (text: string) => directivesApi.sendMessage(selectedCompanyId!, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(thread?.id ?? "") });
      queryClient.invalidateQueries({ queryKey: queryKeys.directives.thread(selectedCompanyId!) });
    },
  });

  // Auto-scroll to bottom when new messages arrive
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

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-2xl space-y-3">
          {timeline.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground gap-2">
              <MessageCircle className="h-8 w-8" />
              <p>Send a message to your CEO agent.</p>
              <p className="text-xs">Your messages become directives the CEO will act on.</p>
            </div>
          )}
          {timeline.map((item, i) => (
            <div key={`${item.kind}:${item.id}`} className="space-y-3">
              {item.kind === "comment" ? (
                <MessageCard comment={item.comment} agentMap={agentMap} />
              ) : (
                <RunCard run={item.run} agentMap={agentMap} />
              )}
              {i === timeline.length - 1 && thread && <LiveRunWidget issueId={thread.id} companyId={thread.companyId} />}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border px-4 py-3 shrink-0">
        <div className="mx-auto max-w-2xl">
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
        </div>
      </div>
    </div>
  );
}
