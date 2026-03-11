import type { Issue, IssueComment } from "@paperclipai/shared";
import { api } from "./client";

export const directivesApi = {
  getThread: (companyId: string) =>
    api.get<Issue>(`/companies/${companyId}/directive-thread`),
  sendMessage: (companyId: string, body: string) =>
    api.post<IssueComment>(`/companies/${companyId}/directive-thread/messages`, { body }),
};
