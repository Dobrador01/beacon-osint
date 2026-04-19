import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  alertas_rss: defineTable({
    guid: v.string(),
    titulo: v.string(),
    link_oficial: v.string(),
    data_publicacao: v.string(),
    nivel_risco: v.string(), 
    cidades_afetadas_ibge: v.array(v.number()), 
    expiresAt: v.number(), 
    conteudo_hash: v.string(), 
  })
    .index("by_guid", ["guid"])
    .index("by_expiresAt", ["expiresAt"]),
});
