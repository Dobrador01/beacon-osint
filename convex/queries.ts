import { query } from "./_generated/server";

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

export const getOsintHealth = query({
  args: {},
  handler: async (ctx: any) => {
    const row = await ctx.db
      .query("osint_health")
      .withIndex("by_source", (q: any) => q.eq("source", "defesa_civil_sc"))
      .first();

    if (!row) return null;

    return {
      lastRunAt: row.lastRunAt,
      lastSuccessAt: row.lastSuccessAt ?? null,
      lastError: row.lastError ?? null,
      itemsProcessed: row.itemsProcessed,
      itemsFailed: row.itemsFailed,
    };
  },
});
