import { mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

// ═══════════════════════════════════════════════════════════════════════════
// Celesc — Reportar snapshot do frontend
// ═══════════════════════════════════════════════════════════════════════════
//
// O frontend (services/celesc.ts) chama esta mutation a cada refresh do
// JSONP da Celesc, enviando SÓ os municípios atualmente afetados (opção (i)).
//
// Lógica:
//   1. Diff contra celesc_state atual:
//      - Chave nova ou com (ucs_afetadas, tendencia) diferente → patch state +
//        history { kind: "change" }
//      - Chave inalterada com último heartbeat > 6h → history { kind: "heartbeat" }
//      - Chave inalterada e fresca → no-op
//   2. Chaves que existiam no state e NÃO vieram no payload → history
//      { kind: "resolved", ucs_afetadas: 0 } + remover do state.
//   3. Bairros são gravados em celesc_state mas NÃO em history (decisão de
//      design — timeline futura usa mapa.gl que renderiza por município).
//   4. Ao final: scheduler.runAfter(0, recomputeDefcon).
//
// Auth: pública sem auth — single-user assumption (dívida documentada).
// ═══════════════════════════════════════════════════════════════════════════

const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 horas

const bairroEntryValidator = v.object({
  bairro: v.string(),
  ucs_afetadas: v.number(),
});

const municipioEntryValidator = v.object({
  ibge_municipio: v.number(),
  municipio_nome: v.string(),
  ucs_afetadas: v.number(),
  ucs_total_municipio: v.optional(v.number()),
  tendencia: v.optional(v.string()),
  bairros: v.optional(v.array(bairroEntryValidator)),
});

type MunicipioEntry = {
  ibge_municipio: number;
  municipio_nome: string;
  ucs_afetadas: number;
  ucs_total_municipio?: number;
  tendencia?: string;
  bairros?: Array<{ bairro: string; ucs_afetadas: number }>;
};

/**
 * Compara campos relevantes pra decidir se "mudou".
 * Mudou = ucs_afetadas diferente OU tendencia diferente.
 */
function mudou(
  state: Doc<"celesc_state">,
  next: { ucs_afetadas: number; tendencia?: string },
): boolean {
  if (state.ucs_afetadas !== next.ucs_afetadas) return true;
  if ((state.tendencia ?? null) !== (next.tendencia ?? null)) return true;
  return false;
}

/**
 * Ergonomia: chave composta (ibge_municipio + bairro?) → string única
 * pra construir Set/Map durante o diff.
 */
function chaveComposta(ibge: number, bairro?: string): string {
  return bairro ? `${ibge}|${bairro}` : `${ibge}|`;
}

export const reportCelescSnapshot = mutation({
  args: {
    snapshot: v.array(municipioEntryValidator),
  },
  handler: async (ctx: MutationCtx, args) => {
    const agora = Date.now();
    const snapshot = args.snapshot as MunicipioEntry[];

    // ── 1. Carregar estado atual completo (~300 rows, OK pra .collect) ───
    const estadoAtual = await ctx.db.query("celesc_state").collect();
    const stateMap = new Map<string, Doc<"celesc_state">>();
    for (const row of estadoAtual) {
      stateMap.set(chaveComposta(row.ibge_municipio, row.bairro), row);
    }

    // ── 2. Construir Set de chaves vindas no snapshot pra detectar resolvidos ──
    const chavesNoSnapshot = new Set<string>();
    for (const m of snapshot) {
      chavesNoSnapshot.add(chaveComposta(m.ibge_municipio, undefined));
      if (m.bairros) {
        for (const b of m.bairros) {
          chavesNoSnapshot.add(chaveComposta(m.ibge_municipio, b.bairro));
        }
      }
    }

    let municipiosChange = 0;
    let municipiosHeartbeat = 0;
    let municipiosResolved = 0;
    let bairrosTouched = 0;

    // ── 3. Processar municípios + bairros do snapshot ────────────────────
    for (const m of snapshot) {
      // (a) Row agregada do município
      const chaveM = chaveComposta(m.ibge_municipio, undefined);
      const stateM = stateMap.get(chaveM);
      const nextM = {
        ucs_afetadas: m.ucs_afetadas,
        tendencia: m.tendencia,
      };

      if (!stateM) {
        // Município novo no estado.
        await ctx.db.insert("celesc_state", {
          ibge_municipio: m.ibge_municipio,
          bairro: undefined,
          municipio_nome: m.municipio_nome,
          ucs_afetadas: m.ucs_afetadas,
          ucs_total_municipio: m.ucs_total_municipio,
          tendencia: m.tendencia,
          atualizado_em: agora,
          ultimo_heartbeat_em: agora,
        });
        await ctx.db.insert("celesc_history", {
          ts: agora,
          ibge_municipio: m.ibge_municipio,
          municipio_nome: m.municipio_nome,
          ucs_afetadas: m.ucs_afetadas,
          ucs_total_municipio: m.ucs_total_municipio,
          tendencia: m.tendencia,
          kind: "change",
        });
        municipiosChange++;
      } else if (mudou(stateM, nextM)) {
        await ctx.db.patch(stateM._id, {
          municipio_nome: m.municipio_nome,
          ucs_afetadas: m.ucs_afetadas,
          ucs_total_municipio: m.ucs_total_municipio,
          tendencia: m.tendencia,
          atualizado_em: agora,
          // ultimo_heartbeat_em NÃO atualiza aqui — change vale como prova de vida
          ultimo_heartbeat_em: agora,
        });
        await ctx.db.insert("celesc_history", {
          ts: agora,
          ibge_municipio: m.ibge_municipio,
          municipio_nome: m.municipio_nome,
          ucs_afetadas: m.ucs_afetadas,
          ucs_total_municipio: m.ucs_total_municipio,
          tendencia: m.tendencia,
          kind: "change",
        });
        municipiosChange++;
      } else {
        // Inalterado — talvez heartbeat.
        await ctx.db.patch(stateM._id, { atualizado_em: agora });
        if (agora - stateM.ultimo_heartbeat_em >= HEARTBEAT_INTERVAL_MS) {
          await ctx.db.insert("celesc_history", {
            ts: agora,
            ibge_municipio: m.ibge_municipio,
            municipio_nome: m.municipio_nome,
            ucs_afetadas: m.ucs_afetadas,
            ucs_total_municipio: m.ucs_total_municipio,
            tendencia: m.tendencia,
            kind: "heartbeat",
          });
          await ctx.db.patch(stateM._id, { ultimo_heartbeat_em: agora });
          municipiosHeartbeat++;
        }
      }

      // (b) Rows de bairro — NÃO escrevem em history (decisão de design)
      if (m.bairros) {
        for (const b of m.bairros) {
          const chaveB = chaveComposta(m.ibge_municipio, b.bairro);
          const stateB = stateMap.get(chaveB);
          if (!stateB) {
            await ctx.db.insert("celesc_state", {
              ibge_municipio: m.ibge_municipio,
              bairro: b.bairro,
              municipio_nome: m.municipio_nome,
              ucs_afetadas: b.ucs_afetadas,
              ucs_total_municipio: undefined,
              tendencia: undefined,
              atualizado_em: agora,
              ultimo_heartbeat_em: agora,
            });
            bairrosTouched++;
          } else if (stateB.ucs_afetadas !== b.ucs_afetadas) {
            await ctx.db.patch(stateB._id, {
              municipio_nome: m.municipio_nome,
              ucs_afetadas: b.ucs_afetadas,
              atualizado_em: agora,
              ultimo_heartbeat_em: agora,
            });
            bairrosTouched++;
          } else {
            await ctx.db.patch(stateB._id, { atualizado_em: agora });
          }
        }
      }
    }

    // ── 4. Detectar chaves que sumiram (resolved) ────────────────────────
    for (const [chave, row] of stateMap.entries()) {
      if (chavesNoSnapshot.has(chave)) continue;
      // Sumiu — registrar resolved.
      if (!row.bairro) {
        // Município agregado: history + delete state
        await ctx.db.insert("celesc_history", {
          ts: agora,
          ibge_municipio: row.ibge_municipio,
          municipio_nome: row.municipio_nome,
          ucs_afetadas: 0,
          ucs_total_municipio: row.ucs_total_municipio,
          tendencia: "RESOLVIDO",
          kind: "resolved",
        });
        municipiosResolved++;
      }
      // Bairro ou município: deletar do state em ambos os casos
      // (presença em state implica afetado; resolved → some).
      await ctx.db.delete(row._id);
    }

    if (municipiosChange + municipiosHeartbeat + municipiosResolved + bairrosTouched > 0) {
      console.log(
        `[CELESC] snapshot processado: ${municipiosChange} change, ${municipiosHeartbeat} heartbeat, ${municipiosResolved} resolved, ${bairrosTouched} bairros`,
      );
    }

    // ── 5. Disparar recompute uma única vez no fim ───────────────────────
    await ctx.scheduler.runAfter(0, internal.defcon.mutations.recomputeDefcon, {});
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// GC — Limpar celesc_history > 90 dias (cron)
// ═══════════════════════════════════════════════════════════════════════════
import { internalMutation } from "../_generated/server";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 200;

export const gcCelescHistory = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    const batch = await ctx.db
      .query("celesc_history")
      .withIndex("by_ts", (q) => q.lt("ts", cutoff))
      .take(DELETE_BATCH_SIZE);

    let deleted = 0;
    for (const row of batch) {
      await ctx.db.delete(row._id);
      deleted++;
    }

    if (deleted > 0) {
      console.log(`[CELESC GC] deleted ${deleted} rows older than 90d`);
    }

    // Se atingiu o limite do batch, agendar continuação (transação Convex
    // tem limite de docs lidos/escritos — recursão via scheduler é o pattern).
    if (deleted === DELETE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.celesc.mutations.gcCelescHistory, {});
    }

    return { deleted };
  },
});
