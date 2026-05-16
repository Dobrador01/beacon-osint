import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

// ═══════════════════════════════════════════════════════════════════════════
// DEFCON — Helpers de desenvolvimento (verificação sem hardware LoRa)
// ═══════════════════════════════════════════════════════════════════════════
//
// Estas mutations são `internal`, então não ficam expostas ao cliente. Para
// usar em verificação, invocar via dashboard Convex:
//   `internal.defcon.dev.injectTestSignal { kind: "alerta", ... }`
//
// USO TÍPICO:
//   1. injectTestSignal { kind: "alerta", nivel_risco: "Alto" }
//      → ingere alerta sintético + dispara recomputeDefcon
//   2. injectTestSignal { kind: "sitrep_ready", categoria: 2, valor: 75 }
//      → cria sitrep "ready" + dispara recomputeDefcon
//   3. injectTestSignal { kind: "telemetry", node_id: "test-1" }
//      → ingere pacote de telemetria + dispara recomputeDefcon
//   4. clearDefconState {}
//      → reseta o singleton DEFCON e limpa sinais sintéticos (rebuild from zero)
//
// SAFETY: o discriminador de "sintético" é o prefixo `dev-test-` em guid /
// node_id / request_id. `clearDefconState` só remove rows com esse prefixo.
// ═══════════════════════════════════════════════════════════════════════════

const DEV_PREFIX = "dev-test-";

export const injectTestSignal = internalMutation({
  args: {
    kind: v.union(
      v.literal("alerta"),
      v.literal("sitrep_ready"),
      v.literal("telemetry"),
    ),
    // Args específicos por kind — todos opcionais, validados no handler.
    nivel_risco: v.optional(v.string()),  // "Alto" | "Medio" | "Baixo"
    cidades_afetadas_ibge: v.optional(v.array(v.number())),
    categoria: v.optional(v.number()),    // 1=ENERGIA, 2=CLIMA, 3=MOBILIDADE
    localidade: v.optional(v.number()),
    valor: v.optional(v.number()),         // 0..100 para sitrep
    node_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const agora = Date.now();
    const tag = `${DEV_PREFIX}${agora}`;

    if (args.kind === "alerta") {
      const nivel = args.nivel_risco ?? "Medio";
      const cidades = args.cidades_afetadas_ibge ?? [4205407]; // default: Florianópolis
      await ctx.db.insert("alertas_rss", {
        guid: tag,
        titulo: `[TEST] Alerta sintético DEFCON ${nivel}`,
        link_oficial: "https://example.invalid/dev",
        data_publicacao: new Date(agora).toISOString(),
        nivel_risco: nivel,
        cidades_afetadas_ibge: cidades,
        expiresAt: agora + 60 * 60 * 1000, // 1h
        conteudo_hash: tag,
      });
      console.log(`[DEV] Alerta sintético inserido: ${tag} nivel=${nivel}`);
    } else if (args.kind === "sitrep_ready") {
      const categoria = args.categoria ?? 2;
      const localidade = args.localidade ?? 1;
      const valor = args.valor ?? 70;
      await ctx.db.insert("sitrep_queue", {
        request_id: tag,
        categoria,
        localidade,
        status: "ready",
        resposta_valor: valor,
        ttl_seconds: 3600,
        expiresAt: agora + 3600 * 1000,
      });
      console.log(`[DEV] Sitrep sintético inserido: ${tag} cat=${categoria} valor=${valor}`);
    } else if (args.kind === "telemetry") {
      const node_id = args.node_id ?? `${DEV_PREFIX}node-1`;
      await ctx.db.insert("telemetry", {
        node_id,
        packet_id: agora,
        timestamp: agora,
        lat: -27.5949,
        lon: -48.5482,
        bitmask_status: 0,
        rssi: -75,
        battery_level: 85,
      });
      console.log(`[DEV] Telemetria sintética inserida: ${node_id}`);
    }

    // Dispara recompute reativo (mesmo path das mutations reais).
    await ctx.scheduler.runAfter(0, internal.defcon.mutations.recomputeDefcon, {});
  },
});

/**
 * Limpa rows sintéticas (prefixo `dev-test-`) e o singleton DEFCON.
 * Útil para resetar o estado entre testes manuais.
 */
export const clearDefconState = internalMutation({
  args: {},
  handler: async (ctx) => {
    let removidos = 0;

    // Singleton DEFCON
    const defcon = await ctx.db
      .query("defcon_status")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();
    if (defcon) {
      await ctx.db.delete(defcon._id);
      removidos++;
    }

    // Alertas sintéticos
    const alertas = await ctx.db.query("alertas_rss").collect();
    for (const a of alertas) {
      if (a.guid.startsWith(DEV_PREFIX)) {
        await ctx.db.delete(a._id);
        removidos++;
      }
    }

    // Sitreps sintéticos
    const sitreps = await ctx.db.query("sitrep_queue").collect();
    for (const s of sitreps) {
      if (s.request_id.startsWith(DEV_PREFIX)) {
        await ctx.db.delete(s._id);
        removidos++;
      }
    }

    // Telemetria sintética
    const telemetria = await ctx.db.query("telemetry").collect();
    for (const t of telemetria) {
      if (t.node_id.startsWith(DEV_PREFIX)) {
        await ctx.db.delete(t._id);
        removidos++;
      }
    }

    console.log(`[DEV] clearDefconState: ${removidos} rows removidas`);
    return { removidos };
  },
});
