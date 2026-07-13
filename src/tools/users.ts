import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI";
import { User } from "../api/types";
import { withErrorHandling } from "./utils/middlewares";
import { buildQueryString } from "./utils/queryString";

export function registerUserTools(server: McpServer, api: PaperlessAPI) {
  server.tool(
    "who_am_i",
    "Return the identity of the user whose API token this MCP connection uses: id, username, name, email, group memberships, and staff/superuser/active flags. Documents uploaded or owned via this connection belong to this user. Useful for 'assign to me' or 'my documents' workflows.",
    {},
    withErrorHandling(async () => {
      if (!api) throw new Error("Please configure API connection first");
      const uiSettings = await api.getUiSettings();
      const sessionUser = uiSettings.user;
      if (!sessionUser?.id || !sessionUser?.username) {
        throw new Error(
          "Could not determine the current user: /api/ui_settings/ did not include user information."
        );
      }

      let fullUser: Partial<User> = sessionUser;
      try {
        fullUser = await api.getUser(sessionUser.id);
      } catch {
        // Token may lack view_user permission; fill in what /api/profile/ offers.
        try {
          const profile = await api.getProfile();
          fullUser = { ...sessionUser, ...profile };
        } catch {
          fullUser = sessionUser;
        }
      }

      const groupIds = fullUser.groups ?? sessionUser.groups ?? [];
      let groups: Array<{ id: number; name: string }> = groupIds.map((id) => ({
        id,
        name: String(id),
      }));
      if (groupIds.length > 0) {
        try {
          const groupsResponse = await api.getGroups(
            `id__in=${groupIds.join(",")}`
          );
          const nameById = new Map(
            (groupsResponse.results ?? []).map((g) => [g.id, g.name])
          );
          groups = groupIds.map((id) => ({
            id,
            name: nameById.get(id) ?? String(id),
          }));
        } catch {
          // Group names are best-effort; ids alone still identify membership.
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: sessionUser.id,
              username: sessionUser.username,
              first_name: fullUser.first_name ?? null,
              last_name: fullUser.last_name ?? null,
              email: fullUser.email ?? null,
              groups,
              is_staff: fullUser.is_staff ?? sessionUser.is_staff ?? null,
              is_superuser:
                fullUser.is_superuser ?? sessionUser.is_superuser ?? null,
              is_active: fullUser.is_active ?? null,
            }),
          },
        ],
      };
    })
  );

  server.tool(
    "list_users",
    "List user accounts with pagination and username filtering. Useful for finding valid owners or permission targets. Requires a token with permission to view users.",
    {
      page: z.number().optional(),
      page_size: z.number().optional(),
      username__icontains: z.string().optional(),
      username__iexact: z.string().optional(),
      ordering: z.string().optional(),
    },
    withErrorHandling(async (args = {}) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const response = await api.getUsers(queryString || undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );

  server.tool(
    "list_groups",
    "List user groups with pagination and name filtering. Useful for finding valid permission targets. Requires a token with permission to view groups.",
    {
      page: z.number().optional(),
      page_size: z.number().optional(),
      name__icontains: z.string().optional(),
      name__iexact: z.string().optional(),
      ordering: z.string().optional(),
    },
    withErrorHandling(async (args = {}) => {
      if (!api) throw new Error("Please configure API connection first");
      const queryString = buildQueryString(args);
      const response = await api.getGroups(queryString || undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    })
  );
}
