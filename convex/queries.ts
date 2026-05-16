import { query, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// ═══════════════════════════════════════════════════════════════════════════
// Beacon OSINT
// ═══════════════════════════════════════════════════════════════════════════

export const listarAlertasAtivos = query({
  args: {},
  handler: async (ctx: any) => {
    const agora = Date.now();
    return await ctx.db
      .query("alertas_rss")
      .withIndex("by_expiresAt")
      .filter((q: any) => q.gte(q.field("expiresAt"), agora))
      .collect();
  },
});

// Query interna para o ingestor verificar existência antes de chamar Gemini
export const buscarPorGuid = internalQuery({
  args: { guid: v.string() },
  handler: async (ctx: any, args: any) => {
    return await ctx.db
      .query("alertas_rss")
      .withIndex("by_guid", (q: any) => q.eq("guid", args.guid))
      .first();
  },
});

/**
 * Health do ingestor da Defesa Civil (singleton). Subscrita pelo
 * BeaconStatusWidget pra mostrar "última verificação há X min" e flag
 * DESATUALIZADO quando passa do threshold (20 min no frontend).
 *
 * Retorna null se o ingestor ainda não rodou neste deploy.
 */
export const getOsintHealth = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("osint_health")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();
    if (!row) return null;
    return {
      lastRunAt: row.lastRunAt,
      lastSuccessAt: row.lastSuccessAt,
      lastError: row.lastError,
      itemsProcessed: row.itemsProcessed,
      itemsFailed: row.itemsFailed,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Grid 48 Gateway
// ═══════════════════════════════════════════════════════════════════════════

export const getSitrepStatus = internalQuery({
  args: { request_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sitrep_queue")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .first();
  },
});
