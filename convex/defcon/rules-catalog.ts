// ═══════════════════════════════════════════════════════════════════════════
// DEFCON — Catálogo de regras (versão 1: regras 6.1, 6.2, 6.3 parametrizadas)
// ═══════════════════════════════════════════════════════════════════════════
//
// As regras lêem thresholds e listas do DefconConfig (singleton em
// defcon_config, fallback em DEFAULT_CONFIG). Usuário ajusta via UI Settings
// sem precisar mudar código.
//
// Regras implementadas:
//   - clima.alerta_alto_grande_floripa (6.1)
//   - energia.bairro_local_critico    (6.2) — UCs absoluto no bairro foco
//   - energia.municipio_secundario_alerta (6.3) — % UC no município
//
// Categoria mobilidade ainda sem regras ativas (placeholder DEFCON 5 até a 6.4
// futura — Gemini lendo notícias locais sobre mobilidade urbana).
// ═══════════════════════════════════════════════════════════════════════════

import type { RuleDefinition } from "./rules";

export const RULES_CATALOG: RuleDefinition[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // 6.1 — Alerta Alto da Defesa Civil cobrindo Grande Florianópolis
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: "clima.alerta_alto_grande_floripa",
    categoria: "clima",
    prioridade: 10,
    predicate: (s) => s.defesa_civil.alto_cobre_grande_floripa,
    nivel_se_match: (c) => clampNivel(c.nivel_alerta_alto_grande_floripa),
    evidencia_template: (s) =>
      `${s.defesa_civil.por_nivel.Alto} alerta(s) Alto da Defesa Civil cobrindo a Grande Florianópolis`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // 6.2 — UCs absoluto no bairro foco (casa OU trabalho)
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: "energia.bairro_local_critico",
    categoria: "energia",
    prioridade: 10,
    predicate: (s, c) => {
      if (c.localidades_foco.length === 0) return false;
      return s.celesc.bairros_foco.some(
        (b) => b.ucs_afetadas >= c.threshold_bairro_ucs,
      );
    },
    nivel_se_match: (c) => clampNivel(c.nivel_bairro_critico),
    evidencia_template: (s, c) => {
      const acionados = s.celesc.bairros_foco.filter(
        (b) => b.ucs_afetadas >= c.threshold_bairro_ucs,
      );
      const detalhes = acionados
        .map((b) => `${b.label} (${b.bairro_celesc}): ${b.ucs_afetadas} UCs`)
        .join("; ");
      return `Bairro foco com >=${c.threshold_bairro_ucs} UCs sem luz: ${detalhes}`;
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // 6.3 — % UC sem luz no município secundário (SJ, Floripa, Palhoça)
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: "energia.municipio_secundario_alerta",
    categoria: "energia",
    prioridade: 20, // depois da 6.2 — mas se 6.2 já casou, 6.3 nem é avaliada
    predicate: (s, c) => {
      return s.celesc.municipios_secundarios.some(
        (m) => m.pct !== null && m.pct >= c.threshold_municipio_pct,
      );
    },
    nivel_se_match: (c) => clampNivel(c.nivel_municipio_alerta),
    evidencia_template: (s, c) => {
      const acionados = s.celesc.municipios_secundarios.filter(
        (m) => m.pct !== null && m.pct >= c.threshold_municipio_pct,
      );
      const detalhes = acionados
        .map((m) => `${m.municipio_nome} ${m.pct!.toFixed(1)}%`)
        .join("; ");
      return `Município secundário com >=${c.threshold_municipio_pct}% UCs sem luz: ${detalhes}`;
    },
  },
];

/**
 * Garante que valores vindos da config caiam em 1..5 (defesa contra config
 * inválida que escapou da validação na mutation).
 */
function clampNivel(n: number): 1 | 2 | 3 | 4 | 5 {
  const clamped = Math.max(1, Math.min(5, Math.round(n)));
  return clamped as 1 | 2 | 3 | 4 | 5;
}
