import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// ═══════════════════════════════════════════════════════════════════════════
// Beacon OSINT — Defesa Civil RSS ingestion
// ═══════════════════════════════════════════════════════════════════════════

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
    // Reativo: alerta novo/atualizado/renovado pode mudar o estado DEFCON.
    // runAfter(0) desacopla — falha no recompute não derruba a ingestão.
    await ctx.scheduler.runAfter(0, internal.defcon.mutations.recomputeDefcon, {});
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

// Mutation leve: renovar TTL sem reprocessar via Gemini (economia de API)
export const refreshTTL = internalMutation({
  args: {
    id: v.id("alertas_rss"),
    expiresAt: v.number(),
  },
  handler: async (ctx: any, args: any) => {
    await ctx.db.patch(args.id, { expiresAt: args.expiresAt });
  }
});

/**
 * Heartbeat do ingestor — chamada do fetchWeatherOSINT ao fim de cada ciclo
 * (sucesso ou erro). Upsert no singleton osint_health pra UI mostrar
 * "última verificação há X min" / flag DESATUALIZADO.
 */
export const recordOsintHealth = internalMutation({
  args: {
    lastRunAt: v.number(),
    lastSuccessAt: v.union(v.number(), v.null()),
    lastError: v.union(v.string(), v.null()),
    itemsProcessed: v.number(),
    itemsFailed: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("osint_health")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("osint_health", { singleton: "global", ...args });
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Grid 48 Gateway — telemetria LoRa + SITREP queue
// ═══════════════════════════════════════════════════════════════════════════

export const ingestTelemetry = internalMutation({
  args: {
    node_id: v.string(),
    packet_id: v.number(),
    timestamp: v.number(),
    lat: v.number(),
    lon: v.number(),
    bitmask_status: v.number(),
    rssi: v.optional(v.number()),
    battery_level: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Deduplication check — many gateways can hear the same node's packet.
    const existing = await ctx.db
      .query("telemetry")
      .withIndex("by_node_packet", (q) =>
        q.eq("node_id", args.node_id).eq("packet_id", args.packet_id)
      )
      .first();

    if (existing) {
      console.log(`[DUPLICATE] Telemetry packet already exists: ${args.node_id}_${args.packet_id}`);
      return existing._id;
    }

    console.log(`[INGEST] New telemetry packet: ${args.node_id}_${args.packet_id}`);
    const id = await ctx.db.insert("telemetry", args);
    // Reativo: novo pacote LoRa pode mudar nodes_online_5min e disparar regras.
    await ctx.scheduler.runAfter(0, internal.defcon.mutations.recomputeDefcon, {});
    return id;
  },
});

export const createSitrepRequest = internalMutation({
  args: {
    request_id: v.string(),
    categoria: v.number(),
    localidade: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sitrep_queue")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .first();

    if (existing) {
      return existing._id;
    }

    console.log(`[SITREP] Created new request: ${args.request_id}`);
    return await ctx.db.insert("sitrep_queue", {
      request_id: args.request_id,
      categoria: args.categoria,
      localidade: args.localidade,
      status: "pending",
      expiresAt: Date.now() + 1000 * 60 * 5, // 5 min TTL
    });
  },
});

export const completeSitrep = internalMutation({
  args: {
    request_id: v.string(),
    resposta_valor: v.number(),
    ttl_seconds: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sitrep_queue")
      .withIndex("by_request_id", (q) => q.eq("request_id", args.request_id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "ready",
        resposta_valor: args.resposta_valor,
        ttl_seconds: args.ttl_seconds,
      });
      console.log(`[SITREP] Completed request: ${args.request_id}`);
      // Reativo: novo sitrep "ready" muda o latest_valor da categoria.
      await ctx.scheduler.runAfter(0, internal.defcon.mutations.recomputeDefcon, {});
    }
  },
});

// Garbage collection: deletes sitrep_queue rows past their expiresAt.
// Runs on cron (see convex/crons.ts). Without this, the table grew forever
// since no path purged completed/expired requests.
export const gcSitrepQueue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("sitrep_queue").collect();
    let deleted = 0;
    for (const row of rows) {
      const expired = typeof row.expiresAt === "number" && row.expiresAt < now;
      if (expired) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    if (deleted > 0) {
      console.log(`[GC] sitrep_queue: deleted ${deleted} expired rows`);
    }
    return { deleted };
  },
});
