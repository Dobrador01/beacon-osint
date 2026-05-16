import { query, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";

// ═══════════════════════════════════════════════════════════════════════════
// DEFCON — Config (singleton parametrizável via UI Settings)
// ═══════════════════════════════════════════════════════════════════════════
//
// Padrão: ausência de row → usar DEFAULT_CONFIG. Primeira gravação na UI
// cria o singleton. As regras em rules_catalog.ts consomem este objeto via
// parâmetro (passado pela recomputeDefcon).
//
// Mutation pública SEM AUTH — single-user assumption (dívida técnica
// documentada). Quando migrar pra multi-user, exigir Convex Auth.
// ═══════════════════════════════════════════════════════════════════════════

// IBGE codes ─ Grande Florianópolis (default)
const IBGE_FLORIANOPOLIS = 4205407;
const IBGE_SAO_JOSE = 4216602;
const IBGE_PALHOCA = 4211900;
const IBGE_BIGUACU = 4202008;

export interface DefconConfig {
  localidades_foco: Array<{
    label: string;
    ibge_municipio: number;
    bairro_celesc: string;
  }>;
  municipios_secundarios: number[];
  grande_florianopolis: number[];
  threshold_bairro_ucs: number;
  nivel_bairro_critico: number;
  threshold_municipio_pct: number;
  nivel_municipio_alerta: number;
  nivel_alerta_alto_grande_floripa: number;
}

/**
 * Defaults usados quando o singleton ainda não existe.
 * Localidades-foco vêm vazias — usuário cadastra na UI usando o dropdown
 * populado por listBairrosConhecidos. Sem cadastro, regra 6.2 nunca dispara.
 */
export const DEFAULT_CONFIG: DefconConfig = {
  localidades_foco: [],
  municipios_secundarios: [IBGE_SAO_JOSE, IBGE_FLORIANOPOLIS, IBGE_PALHOCA],
  grande_florianopolis: [IBGE_FLORIANOPOLIS, IBGE_SAO_JOSE, IBGE_PALHOCA, IBGE_BIGUACU],
  threshold_bairro_ucs: 30,           // 6.2 chute inicial — refinar via Settings
  nivel_bairro_critico: 3,            // 6.2 → DEFCON 3
  threshold_municipio_pct: 30,        // 6.3 → 30%
  nivel_municipio_alerta: 4,          // 6.3 → DEFCON 4
  nivel_alerta_alto_grande_floripa: 3, // 6.1 → DEFCON 3
};

/**
 * Helper interno: retorna config persistida ou defaults. Usado por
 * recomputeDefcon e pela query pública.
 */
export async function readConfigOrDefaults(
  ctx: { db: { query: (...args: any[]) => any } },
): Promise<DefconConfig> {
  const row = await ctx.db
    .query("defcon_config")
    .withIndex("by_singleton", (q: any) => q.eq("singleton", "global"))
    .unique();
  if (!row) return DEFAULT_CONFIG;
  return {
    localidades_foco: row.localidades_foco,
    municipios_secundarios: row.municipios_secundarios,
    grande_florianopolis: row.grande_florianopolis,
    threshold_bairro_ucs: row.threshold_bairro_ucs,
    nivel_bairro_critico: row.nivel_bairro_critico,
    threshold_municipio_pct: row.threshold_municipio_pct,
    nivel_municipio_alerta: row.nivel_municipio_alerta,
    nivel_alerta_alto_grande_floripa: row.nivel_alerta_alto_grande_floripa,
  };
}

/**
 * Query pública subscrita pela UI Settings. Sempre retorna um objeto válido
 * (defaults se ausente) — UI nunca precisa lidar com null.
 */
export const getDefconConfig = query({
  args: {},
  handler: async (ctx): Promise<DefconConfig & { _exists: boolean }> => {
    const row: Doc<"defcon_config"> | null = await ctx.db
      .query("defcon_config")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();
    if (!row) return { ...DEFAULT_CONFIG, _exists: false };
    return {
      localidades_foco: row.localidades_foco,
      municipios_secundarios: row.municipios_secundarios,
      grande_florianopolis: row.grande_florianopolis,
      threshold_bairro_ucs: row.threshold_bairro_ucs,
      nivel_bairro_critico: row.nivel_bairro_critico,
      threshold_municipio_pct: row.threshold_municipio_pct,
      nivel_municipio_alerta: row.nivel_municipio_alerta,
      nivel_alerta_alto_grande_floripa: row.nivel_alerta_alto_grande_floripa,
      _exists: true,
    };
  },
});

/**
 * Mutation pública (SEM AUTH — dívida técnica). Substitui o singleton inteiro.
 * UI envia config completa, não diff parcial — simples, idempotente.
 * Dispara recomputeDefcon após salvar (mudança de threshold pode mudar nível).
 */
export const updateDefconConfig = mutation({
  args: {
    localidades_foco: v.array(v.object({
      label: v.string(),
      ibge_municipio: v.number(),
      bairro_celesc: v.string(),
    })),
    municipios_secundarios: v.array(v.number()),
    grande_florianopolis: v.array(v.number()),
    threshold_bairro_ucs: v.number(),
    nivel_bairro_critico: v.number(),
    threshold_municipio_pct: v.number(),
    nivel_municipio_alerta: v.number(),
    nivel_alerta_alto_grande_floripa: v.number(),
  },
  handler: async (ctx, args) => {
    // Validação básica de níveis DEFCON (1..5).
    for (const k of ["nivel_bairro_critico", "nivel_municipio_alerta", "nivel_alerta_alto_grande_floripa"] as const) {
      const v = args[k];
      if (!Number.isInteger(v) || v < 1 || v > 5) {
        throw new Error(`${k} deve ser inteiro entre 1 e 5 (recebido: ${v})`);
      }
    }
    if (args.threshold_bairro_ucs < 0) {
      throw new Error("threshold_bairro_ucs não pode ser negativo");
    }
    if (args.threshold_municipio_pct < 0 || args.threshold_municipio_pct > 100) {
      throw new Error("threshold_municipio_pct deve estar entre 0 e 100");
    }

    const existing = await ctx.db
      .query("defcon_config")
      .withIndex("by_singleton", (q) => q.eq("singleton", "global"))
      .unique();

    const payload = {
      ...args,
      atualizado_em: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      console.log("[DEFCON CONFIG] atualizado");
    } else {
      await ctx.db.insert("defcon_config", { singleton: "global", ...payload });
      console.log("[DEFCON CONFIG] criado (primeira vez)");
    }

    // Mudança de config pode mudar o nível DEFCON imediatamente.
    await ctx.scheduler.runAfter(0, internal.defcon.mutations.recomputeDefcon, {});
  },
});
