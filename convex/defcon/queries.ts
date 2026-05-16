import { query, internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

// ═══════════════════════════════════════════════════════════════════════════
// DEFCON — Queries
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Query pública subscrita pelo widget DEFCON do Grid 48.
 * Lê a linha singleton (singleton="global"). Se ainda não existe, retorna null.
 */
export const getDefconStatus = query({
  args: {},
  handler: async (ctx): Promise<Doc<"defcon_status"> | null> => {
    return await ctx.db
      .query("defcon_status")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();
  },
});

/**
 * Query interna usada pela action `explainDefcon` para re-checar
 * que o `inputs_hash` ainda é o atual antes de chamar Gemini (anti-corrida).
 */
export const _getDefconRowInternal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"defcon_status"> | null> => {
    return await ctx.db
      .query("defcon_status")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();
  },
});
