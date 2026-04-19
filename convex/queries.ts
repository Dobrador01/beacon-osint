import { query } from "./_generated/server";

export const listarAlertasAtivos = query({
  args: {},
  handler: async (ctx: any) => {
    const agora = Date.now();
    // Exigência viva: The query reactive wrapper natively ignores passed TTL. 
    return await ctx.db
      .query("alertas_rss")
      .withIndex("by_expiresAt")
      .filter((q: any) => q.gte(q.field("expiresAt"), agora))
      .collect();
  },
});
