import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import {
  computeDefcon,
  hashSignals,
  type AggregatedSignals,
  type Categoria,
  type DefconLevel,
} from "./rules";
import { RULES_CATALOG } from "./rules_catalog";
import { readConfigOrDefaults, type DefconConfig } from "./config";

// ═══════════════════════════════════════════════════════════════════════════
// DEFCON — Mutations (recomputeDefcon + saveExplicacao)
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIAS_NUM_TO_NAME: Record<number, Categoria> = {
  1: "energia",
  2: "clima",
  3: "mobilidade",
};

/**
 * Lê os sinais agregados das tabelas operacionais. Função auxiliar para manter
 * a `recomputeDefcon` enxuta. Toda leitura usa índices conforme guidelines.
 *
 * Recebe `config` pra saber QUAIS bairros/municípios filtrar — sem isso, o
 * snapshot de signals seria gigante (todo o estado Celesc).
 */
async function buildAggregatedSignals(
  ctx: MutationCtx,
  config: DefconConfig,
): Promise<AggregatedSignals> {
  const agora = Date.now();

  // ── 1. Alertas ativos da Defesa Civil ────────────────────────────────────
  const alertas = await ctx.db
    .query("alertas_rss")
    .withIndex("by_expiresAt", (q) => q.gte("expiresAt", agora))
    .collect();

  const por_nivel = { Alto: 0, Medio: 0, Baixo: 0 };
  const grandeFloripaSet = new Set(config.grande_florianopolis);
  let altoCobreGrandeFloripa = false;

  for (const al of alertas) {
    if (al.nivel_risco === "Alto") por_nivel.Alto++;
    else if (al.nivel_risco === "Medio") por_nivel.Medio++;
    else if (al.nivel_risco === "Baixo") por_nivel.Baixo++;

    if (al.nivel_risco === "Alto") {
      // Cobre Grande Floripa se interseção entre cidades_afetadas_ibge e config.grande_florianopolis > 0
      for (const ibge of al.cidades_afetadas_ibge) {
        if (grandeFloripaSet.has(ibge)) {
          altoCobreGrandeFloripa = true;
          break;
        }
      }
    }
  }

  // ── 2. Celesc — bairros foco e municípios secundários ───────────────────
  // Lookup pontual em vez de carregar tudo: índice by_chave.
  const bairros_foco: AggregatedSignals["celesc"]["bairros_foco"] = [];
  for (const loc of config.localidades_foco) {
    const row = await ctx.db
      .query("celesc_state")
      .withIndex("by_chave", (q) =>
        q.eq("ibge_municipio", loc.ibge_municipio).eq("bairro", loc.bairro_celesc),
      )
      .unique();
    bairros_foco.push({
      label: loc.label,
      bairro_celesc: loc.bairro_celesc,
      ibge_municipio: loc.ibge_municipio,
      ucs_afetadas: row?.ucs_afetadas ?? 0,
    });
  }

  const municipios_secundarios: AggregatedSignals["celesc"]["municipios_secundarios"] = [];
  for (const ibge of config.municipios_secundarios) {
    // Row agregada do município (bairro = undefined). Como o índice by_chave
    // requer eq em ambos os campos, usamos by_municipio + filter em memória.
    const rows = await ctx.db
      .query("celesc_state")
      .withIndex("by_municipio", (q) => q.eq("ibge_municipio", ibge))
      .collect();
    const agregada = rows.find((r) => r.bairro === undefined);
    if (agregada) {
      const ucsTotal = agregada.ucs_total_municipio ?? null;
      municipios_secundarios.push({
        ibge_municipio: ibge,
        municipio_nome: agregada.municipio_nome,
        ucs_afetadas: agregada.ucs_afetadas,
        ucs_total: ucsTotal,
        pct: ucsTotal && ucsTotal > 0 ? (agregada.ucs_afetadas / ucsTotal) * 100 : null,
      });
    } else {
      municipios_secundarios.push({
        ibge_municipio: ibge,
        municipio_nome: `(IBGE ${ibge})`,
        ucs_afetadas: 0,
        ucs_total: null,
        pct: 0,
      });
    }
  }

  // ── 3. Sitrep latest "ready" por categoria ───────────────────────────────
  const readySitreps = await ctx.db
    .query("sitrep_queue")
    .withIndex("by_status", (q) => q.eq("status", "ready"))
    .collect();

  const sitrepLatest: Record<Categoria, { latest_valor: number | null; idade_seg: number | null }> = {
    energia: { latest_valor: null, idade_seg: null },
    clima: { latest_valor: null, idade_seg: null },
    mobilidade: { latest_valor: null, idade_seg: null },
  };

  const ordenados = readySitreps.sort((a, b) => b._creationTime - a._creationTime);
  for (const row of ordenados) {
    const cat = CATEGORIAS_NUM_TO_NAME[row.categoria];
    if (!cat) continue;
    if (sitrepLatest[cat].latest_valor === null && typeof row.resposta_valor === "number") {
      sitrepLatest[cat] = {
        latest_valor: row.resposta_valor,
        idade_seg: Math.floor((agora - row._creationTime) / 1000),
      };
    }
  }

  return {
    defesa_civil: {
      ativos_total: alertas.length,
      por_nivel,
      alto_cobre_grande_floripa: altoCobreGrandeFloripa,
    },
    celesc: {
      bairros_foco,
      municipios_secundarios,
    },
    sitrep: {
      por_categoria: sitrepLatest,
    },
    agora,
  };
}

/**
 * Recalcula o estado DEFCON a partir das tabelas operacionais e persiste
 * o singleton `defcon_status`. Idempotente — se inputs_hash não mudou, no-op.
 *
 * Disparada reativamente pelo scheduler após upsertAlerta / ingestTelemetry /
 * completeSitrep. Pode também ser chamada manualmente via dashboard Convex.
 */
export const recomputeDefcon = internalMutation({
  args: {},
  handler: async (ctx) => {
    const agora = Date.now();
    const config = await readConfigOrDefaults(ctx);
    const signals = await buildAggregatedSignals(ctx, config);
    const result = computeDefcon(signals, config, RULES_CATALOG);
    const inputs_hash = hashSignals(signals);

    const existing = await ctx.db
      .query("defcon_status")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();

    // Caso 1: nunca existiu → insert inicial.
    if (!existing) {
      await ctx.db.insert("defcon_status", {
        singleton: "global",
        nivel_global: result.nivel_global,
        niveis_categoria: result.niveis_categoria,
        inputs_hash,
        sinais_disparadores: result.sinais_disparadores,
        explicacao: undefined,
        nivel_anterior: undefined,
        recomputado_em: agora,
        ultima_mudanca_em: agora,
      });
      console.log(`[DEFCON] init nivel=${result.nivel_global} hash=${inputs_hash}`);
      // Agendar geração de explicação Gemini (assíncrona, não bloqueia)
      await ctx.scheduler.runAfter(0, internal.defcon.actions.explainDefcon, {
        inputs_hash,
        nivel_global: result.nivel_global,
        niveis_categoria: result.niveis_categoria,
        sinais_disparadores: result.sinais_disparadores,
      });
      return;
    }

    // Caso 2: hash igual → nada mudou, no-op (curto-circuito barato).
    if (existing.inputs_hash === inputs_hash) {
      // Atualizar só recomputado_em pra UI saber que checamos recentemente.
      await ctx.db.patch(existing._id, { recomputado_em: agora });
      return;
    }

    // Caso 3: hash diferente → patch + (se nível mudou) agenda explicação.
    const nivelMudou = existing.nivel_global !== result.nivel_global;
    await ctx.db.patch(existing._id, {
      nivel_global: result.nivel_global,
      niveis_categoria: result.niveis_categoria,
      inputs_hash,
      sinais_disparadores: result.sinais_disparadores,
      recomputado_em: agora,
      ...(nivelMudou
        ? {
            nivel_anterior: existing.nivel_global,
            ultima_mudanca_em: agora,
          }
        : {}),
    });

    if (nivelMudou) {
      console.log(
        `[DEFCON] recomputado ${existing.nivel_global}→${result.nivel_global} hash=${inputs_hash}`,
      );
    }

    // Sempre que hash mudou, vale gerar nova explicação (mesmo se nível não
    // mudou, porque os sinais disparadores mudaram).
    await ctx.scheduler.runAfter(0, internal.defcon.actions.explainDefcon, {
      inputs_hash,
      nivel_global: result.nivel_global,
      niveis_categoria: result.niveis_categoria,
      sinais_disparadores: result.sinais_disparadores,
    });
  },
});

/**
 * Persiste a explicação gerada pela action `explainDefcon`. Re-valida que
 * `inputs_hash` ainda bate antes do patch — se outra recomputação venceu
 * a corrida, o texto é stale e descartamos.
 */
export const saveExplicacao = internalMutation({
  args: {
    inputs_hash: v.string(),
    texto: v.string(),
    modelo: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("defcon_status")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();
    if (!row) return; // nada a fazer
    if (row.inputs_hash !== args.inputs_hash) {
      console.log(
        `[DEFCON] explicacao descartada (hash stale): ${args.inputs_hash} != ${row.inputs_hash}`,
      );
      return;
    }
    await ctx.db.patch(row._id, {
      explicacao: {
        texto: args.texto,
        gerada_em: Date.now(),
        inputs_hash: args.inputs_hash,
        modelo: args.modelo,
      },
    });
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Re-export de tipos pra facilitar imports em actions.ts (workaround Convex
// circularity — actions importam de mutations e vice-versa).
// ───────────────────────────────────────────────────────────────────────────
export type { Categoria, DefconLevel };
