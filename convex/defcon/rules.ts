// ═══════════════════════════════════════════════════════════════════════════
// DEFCON — Função pura de cálculo de nível
// ═══════════════════════════════════════════════════════════════════════════
//
// Sem `ctx`, sem I/O, sem Gemini. Recebe sinais agregados + config, aplica
// regras parametrizadas, produz nível por categoria + nível global. Testável
// standalone (rules.test.ts).
//
// Convenção militar:
//   1 = mais crítico (ação imediata)
//   2 = alto
//   3 = elevado
//   4 = atenção
//   5 = tranquilo / normal (default)
//
// Agregação global = min(níveis_categoria) — pior categoria define o estado.
// ═══════════════════════════════════════════════════════════════════════════

import type { DefconConfig } from "./config";

export type DefconLevel = 1 | 2 | 3 | 4 | 5;

export type Categoria = "energia" | "clima" | "mobilidade";

export const DEFCON_DEFAULT: DefconLevel = 5;

/**
 * Snapshot dos sinais que alimentam o cálculo. Construído por
 * recomputeDefcon lendo alertas_rss / celesc_state / sitrep_queue.
 *
 * NÃO incluir aqui nada que mude por motivos não-DEFCON, porque o hash
 * desta estrutura é o cache key da explicação Gemini.
 */
export interface AggregatedSignals {
  defesa_civil: {
    ativos_total: number;
    por_nivel: { Alto: number; Medio: number; Baixo: number };
    /** True se há ao menos um alerta Alto cobrindo um IBGE da Grande Floripa */
    alto_cobre_grande_floripa: boolean;
  };
  celesc: {
    /** UCs afetadas em cada bairro foco (lookup por label da config). */
    bairros_foco: Array<{
      label: string;
      bairro_celesc: string;
      ibge_municipio: number;
      ucs_afetadas: number;
    }>;
    /** % UCs afetadas por município secundário (denominador = ucs_total_municipio) */
    municipios_secundarios: Array<{
      ibge_municipio: number;
      municipio_nome: string;
      ucs_afetadas: number;
      ucs_total: number | null;
      pct: number | null;  // null se ucs_total ausente
    }>;
  };
  sitrep: {
    por_categoria: {
      energia: { latest_valor: number | null; idade_seg: number | null };
      clima: { latest_valor: number | null; idade_seg: number | null };
      mobilidade: { latest_valor: number | null; idade_seg: number | null };
    };
  };
  agora: number;
}

export interface RuleDefinition {
  id: string;
  categoria: Categoria;
  /** Ordem de avaliação dentro da categoria (menor = mais prioritário). */
  prioridade: number;
  predicate: (s: AggregatedSignals, c: DefconConfig) => boolean;
  /** Nível alvo se a regra casar. Pode ser função pra extrair da config. */
  nivel_se_match: (c: DefconConfig) => DefconLevel;
  evidencia_template: (s: AggregatedSignals, c: DefconConfig) => string;
}

export interface SinalDisparador {
  categoria: string;
  regra_id: string;
  evidencia: string;
}

export interface ComputeResult {
  niveis_categoria: Record<Categoria, DefconLevel>;
  nivel_global: DefconLevel;
  sinais_disparadores: SinalDisparador[];
}

function computeCategoriaLevel(
  signals: AggregatedSignals,
  config: DefconConfig,
  rules: RuleDefinition[],
  categoria: Categoria,
): { nivel: DefconLevel; disparador: SinalDisparador | null } {
  const ordenadas = rules
    .filter((r) => r.categoria === categoria)
    .sort((a, b) => a.prioridade - b.prioridade);

  for (const regra of ordenadas) {
    if (regra.predicate(signals, config)) {
      return {
        nivel: regra.nivel_se_match(config),
        disparador: {
          categoria,
          regra_id: regra.id,
          evidencia: regra.evidencia_template(signals, config),
        },
      };
    }
  }

  return { nivel: DEFCON_DEFAULT, disparador: null };
}

/**
 * Agregação global: pior categoria define o estado geral.
 * min() porque DEFCON 1 é o mais crítico (convenção militar invertida).
 */
export function combineCategorias(niveis: Record<Categoria, DefconLevel>): DefconLevel {
  return Math.min(niveis.energia, niveis.clima, niveis.mobilidade) as DefconLevel;
}

export function computeDefcon(
  signals: AggregatedSignals,
  config: DefconConfig,
  rules: RuleDefinition[],
): ComputeResult {
  const energia = computeCategoriaLevel(signals, config, rules, "energia");
  const clima = computeCategoriaLevel(signals, config, rules, "clima");
  const mobilidade = computeCategoriaLevel(signals, config, rules, "mobilidade");

  const niveis_categoria: Record<Categoria, DefconLevel> = {
    energia: energia.nivel,
    clima: clima.nivel,
    mobilidade: mobilidade.nivel,
  };

  const sinais_disparadores: SinalDisparador[] = [
    energia.disparador,
    clima.disparador,
    mobilidade.disparador,
  ].filter((d): d is SinalDisparador => d !== null);

  return {
    niveis_categoria,
    nivel_global: combineCategorias(niveis_categoria),
    sinais_disparadores,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Hash determinístico dos sinais — cache key da explicação Gemini.
// FNV-1a 32-bit, stringify ordenado. Não-criptográfico, só estável e barato.
// ───────────────────────────────────────────────────────────────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

export function hashSignals(signals: AggregatedSignals): string {
  // Removemos `agora` do hash — varia a cada recompute e invalidaria cache à toa.
  const { agora: _omit, ...stable } = signals;
  const str = stableStringify(stable);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
