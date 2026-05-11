import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Consolidated schema: hosts both the Beacon OSINT pipeline (alertas_rss) and
// the Grid 48 Gateway domain (telemetry + sitrep_queue). Tables are disjoint
// — no foreign keys cross the boundary — so future re-separation is trivial.
export default defineSchema({
  // ── Beacon OSINT (Defesa Civil RSS → Gemini → upsert) ──────────────────
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

  // ── Grid 48 Gateway (telemetria LoRa + SITREP IA) ──────────────────────
  telemetry: defineTable({
    node_id: v.string(),
    packet_id: v.number(),
    timestamp: v.number(),
    lat: v.number(),
    lon: v.number(),
    bitmask_status: v.number(),
    rssi: v.optional(v.number()),
    battery_level: v.optional(v.number()),
  })
    .index("by_node_packet", ["node_id", "packet_id"])
    .index("by_timestamp", ["timestamp"]),

  sitrep_queue: defineTable({
    request_id: v.string(),
    categoria: v.number(),  // CategoriaSitrep enum (1=ENERGIA, 2=CLIMA, 3=MOBILIDADE)
    localidade: v.number(), // LocalidadeMacro enum (1=Floripa, 2=Sao Jose, ...)
    status: v.string(),     // "pending" | "ready" | "expired"
    resposta_valor: v.optional(v.number()),
    ttl_seconds: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_request_id", ["request_id"])
    .index("by_status", ["status"]),
});
