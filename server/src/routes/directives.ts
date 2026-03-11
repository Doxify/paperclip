import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import {
  agentService,
  heartbeatService,
  issueService,
  logActivity,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const DIRECTIVE_BILLING_CODE = "__directive_thread__";

export function directiveRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);
  const heartbeat = heartbeatService(db);

  async function findCeoAgent(companyId: string) {
    const [ceo] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.role, "ceo"),
          isNull(agents.reportsTo),
        ),
      )
      .limit(1);
    return ceo ?? null;
  }

  async function findOrCreateThread(companyId: string, ceoAgentId: string) {
    const [existing] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.billingCode, DIRECTIVE_BILLING_CODE),
        ),
      )
      .limit(1);

    if (existing) return existing;

    return svc.create(companyId, {
      title: "Board Directives",
      status: "in_progress",
      assigneeAgentId: ceoAgentId,
      billingCode: DIRECTIVE_BILLING_CODE,
      priority: "medium",
    });
  }

  router.get("/companies/:companyId/directive-thread", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const ceo = await findCeoAgent(companyId);
    if (!ceo) {
      res.status(404).json({ error: "No CEO agent found. Create a CEO agent first." });
      return;
    }

    const thread = await findOrCreateThread(companyId, ceo.id);
    res.json(thread);
  });

  router.post("/companies/:companyId/directive-thread/messages", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const { body } = req.body as { body: string };
    if (!body || typeof body !== "string" || !body.trim()) {
      res.status(400).json({ error: "body is required" });
      return;
    }

    const ceo = await findCeoAgent(companyId);
    if (!ceo) {
      res.status(404).json({ error: "No CEO agent found. Create a CEO agent first." });
      return;
    }

    const thread = await findOrCreateThread(companyId, ceo.id);

    const comment = await svc.addComment(thread.id, body.trim(), {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: thread.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: thread.identifier,
        issueTitle: thread.title,
      },
    });

    // Wake the CEO agent
    void heartbeat
      .wakeup(ceo.id, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "board_directive",
        payload: {
          issueId: thread.id,
          commentId: comment.id,
          mutation: "comment",
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: thread.id,
          taskId: thread.id,
          commentId: comment.id,
          source: "directive_thread",
          wakeReason: "board_directive",
        },
      })
      .catch((err) =>
        logger.warn({ err, issueId: thread.id, agentId: ceo.id }, "failed to wake CEO on directive"),
      );

    res.status(201).json(comment);
  });

  return router;
}
