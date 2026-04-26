import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const upsertAlerta = internalMutation({
  args: {
    guid: v.string(),
    titulo: v.string(),
    link_oficial: v.string(),
    data_publicacao: v.string(),
    nivel_risco: v.string(),
    cidades_afetadas_ibge: v.array(v.number()),
    expiresAt: v.number(),
    conteudo_hash: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const existing = await ctx.db
      .query("alertas_rss")
      .withIndex("by_guid", (q: any) => q.eq("guid", args.guid))
      .first();

    if (existing) {
      if (existing.conteudo_hash !== args.conteudo_hash) {
        await ctx.db.patch(existing._id, { ...args });
        console.log(`[UPSERT] Alerta evoluiu e foi atualizado no DB: ${args.guid}`);
      } else {
        // Renovar janela de expiração para manter alerta vivo enquanto a Defesa Civil continuar publicando
        await ctx.db.patch(existing._id, { expiresAt: args.expiresAt });
        console.log(`[TTL-REFRESH] Janela de expiração renovada para: ${args.guid}`);
      }
    } else {
      await ctx.db.insert("alertas_rss", args);
      console.log(`[INSERCAO] Nova ameaça estruturada via RSS registrada no Grid: ${args.guid}`);
    }
  },
});

export const deleteExpiredAlerts = internalMutation({
  args: {},
  handler: async (ctx: any) => {
    const agora = Date.now();
    const expired = await ctx.db
      .query("alertas_rss")
      .withIndex("by_expiresAt", (q: any) => q.lt("expiresAt", agora))
      .collect();

    for (const doc of expired) {
      await ctx.db.delete(doc._id);
    }
    console.log(`[GC] ${expired.length} alertas antigos destruidos com sucesso.`);
  }
});
