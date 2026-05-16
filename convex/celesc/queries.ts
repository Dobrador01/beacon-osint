import { query } from "../_generated/server";
import { v } from "convex/values";

// ═══════════════════════════════════════════════════════════════════════════
// Celesc — Queries públicas
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Estado atual completo (latest por chave). Usado pelo widget DEFCON e por
 * debug. Volume baixo (~300 rows em pico), .collect é seguro.
 */
export const getCelescState = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("celesc_state").collect();
  },
});

/**
 * Lista distinta de bairros já vistos no estado atual. Usada pela UI
 * Settings pra popular o dropdown "selecione seu bairro" — evita typo
 * silencioso na string.
 *
 * Retorna ordenado por município, depois por bairro.
 */
export const listBairrosConhecidos = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("celesc_state").collect();
    const bairros = all
      .filter((r) => typeof r.bairro === "string" && r.bairro.length > 0)
      .map((r) => ({
        ibge_municipio: r.ibge_municipio,
        municipio_nome: r.municipio_nome,
        bairro: r.bairro!,
        ucs_afetadas_no_momento: r.ucs_afetadas,
      }));

    bairros.sort((a, b) => {
      if (a.municipio_nome !== b.municipio_nome) {
        return a.municipio_nome.localeCompare(b.municipio_nome);
      }
      return a.bairro.localeCompare(b.bairro);
    });

    return bairros;
  },
});

/**
 * Histórico de um município específico nos últimos N ms. Pra timeline futura.
 * Não usada pelo DEFCON — só exposta pra UI futura.
 */
export const getMunicipioHistory = query({
  args: {
    ibge_municipio: v.number(),
    desde_ms: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.desde_ms;
    return await ctx.db
      .query("celesc_history")
      .withIndex("by_municipio_ts", (q) =>
        q.eq("ibge_municipio", args.ibge_municipio).gte("ts", cutoff),
      )
      .collect();
  },
});
