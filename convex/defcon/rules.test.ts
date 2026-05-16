// ═══════════════════════════════════════════════════════════════════════════
// DEFCON — Testes unitários do catálogo de regras
// ═══════════════════════════════════════════════════════════════════════════
//
// PRÉ-REQUISITO: instale o runner antes de executar.
//   pnpm add -D vitest @edge-runtime/vm
// (alinhado com convex/_generated/ai/guidelines.md)
//
// COMO RODAR:
//   pnpm vitest run convex/defcon/rules.test.ts
//
// Testes da função pura (sem ctx Convex). Cobrem regras 6.1, 6.2, 6.3 do
// catálogo atual, agregação min, e estabilidade do hash.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest";
import {
  computeDefcon,
  combineCategorias,
  hashSignals,
  DEFCON_DEFAULT,
  type AggregatedSignals,
  type DefconLevel,
} from "./rules";
import { RULES_CATALOG } from "./rules_catalog";
import { DEFAULT_CONFIG, type DefconConfig } from "./config";

const IBGE_FLORIANOPOLIS = 4205407;
const IBGE_SAO_JOSE = 4216602;
const IBGE_PALHOCA = 4211900;

function emptySignals(overrides: Partial<AggregatedSignals> = {}): AggregatedSignals {
  return {
    defesa_civil: {
      ativos_total: 0,
      por_nivel: { Alto: 0, Medio: 0, Baixo: 0 },
      alto_cobre_grande_floripa: false,
    },
    celesc: {
      bairros_foco: [],
      municipios_secundarios: [],
    },
    sitrep: {
      por_categoria: {
        energia: { latest_valor: null, idade_seg: null },
        clima: { latest_valor: null, idade_seg: null },
        mobilidade: { latest_valor: null, idade_seg: null },
      },
    },
    agora: 1_700_000_000_000,
    ...overrides,
  };
}

function configComLocalidades(): DefconConfig {
  return {
    ...DEFAULT_CONFIG,
    localidades_foco: [
      { label: "Casa", ibge_municipio: IBGE_SAO_JOSE, bairro_celesc: "Ipiranga" },
      { label: "Trabalho", ibge_municipio: IBGE_PALHOCA, bairro_celesc: "Furadinho" },
    ],
  };
}

describe("computeDefcon — defaults", () => {
  it("sem sinais e sem config preenchida, todas categorias caem para DEFCON 5", () => {
    const result = computeDefcon(emptySignals(), DEFAULT_CONFIG, RULES_CATALOG);
    expect(result.niveis_categoria.energia).toBe(5);
    expect(result.niveis_categoria.clima).toBe(5);
    expect(result.niveis_categoria.mobilidade).toBe(5);
    expect(result.nivel_global).toBe(5);
    expect(result.sinais_disparadores).toHaveLength(0);
  });

  it("DEFCON_DEFAULT é 5", () => {
    expect(DEFCON_DEFAULT).toBe(5);
  });

  it("mobilidade fica em DEFCON 5 sempre (sem regras ativas no catálogo)", () => {
    const s = emptySignals();
    s.defesa_civil.alto_cobre_grande_floripa = true; // dispara clima
    const r = computeDefcon(s, DEFAULT_CONFIG, RULES_CATALOG);
    expect(r.niveis_categoria.mobilidade).toBe(5);
  });
});

describe("regra 6.1 — alerta Alto cobrindo Grande Florianópolis", () => {
  it("alerta Alto cobre Grande Floripa → DEFCON 3 em clima", () => {
    const s = emptySignals();
    s.defesa_civil.alto_cobre_grande_floripa = true;
    s.defesa_civil.por_nivel.Alto = 1;
    const r = computeDefcon(s, DEFAULT_CONFIG, RULES_CATALOG);
    expect(r.niveis_categoria.clima).toBe(3);
  });

  it("alerta Alto sem cobrir Grande Floripa → não dispara", () => {
    const s = emptySignals();
    s.defesa_civil.alto_cobre_grande_floripa = false;
    s.defesa_civil.por_nivel.Alto = 1;
    expect(computeDefcon(s, DEFAULT_CONFIG, RULES_CATALOG).niveis_categoria.clima).toBe(5);
  });

  it("nivel configurável pela config", () => {
    const config: DefconConfig = { ...DEFAULT_CONFIG, nivel_alerta_alto_grande_floripa: 2 };
    const s = emptySignals();
    s.defesa_civil.alto_cobre_grande_floripa = true;
    expect(computeDefcon(s, config, RULES_CATALOG).niveis_categoria.clima).toBe(2);
  });
});

describe("regra 6.2 — bairro foco com UCs absoluto", () => {
  it("threshold 30, bairro foco com 35 UCs → DEFCON 3 em energia", () => {
    const config = configComLocalidades();
    const s = emptySignals();
    s.celesc.bairros_foco = [
      { label: "Casa", bairro_celesc: "Ipiranga", ibge_municipio: IBGE_SAO_JOSE, ucs_afetadas: 35 },
      { label: "Trabalho", bairro_celesc: "Furadinho", ibge_municipio: IBGE_PALHOCA, ucs_afetadas: 0 },
    ];
    expect(computeDefcon(s, config, RULES_CATALOG).niveis_categoria.energia).toBe(3);
  });

  it("threshold 30, ambos bairros abaixo → não dispara", () => {
    const config = configComLocalidades();
    const s = emptySignals();
    s.celesc.bairros_foco = [
      { label: "Casa", bairro_celesc: "Ipiranga", ibge_municipio: IBGE_SAO_JOSE, ucs_afetadas: 5 },
      { label: "Trabalho", bairro_celesc: "Furadinho", ibge_municipio: IBGE_PALHOCA, ucs_afetadas: 10 },
    ];
    expect(computeDefcon(s, config, RULES_CATALOG).niveis_categoria.energia).toBe(5);
  });

  it("sem localidades_foco cadastradas → regra nunca dispara", () => {
    // Mesmo com bairros_foco no payload (improvável sem config), regra exige config.localidades_foco.length > 0
    const s = emptySignals();
    s.celesc.bairros_foco = [
      { label: "Fantasma", bairro_celesc: "X", ibge_municipio: 0, ucs_afetadas: 999 },
    ];
    expect(computeDefcon(s, DEFAULT_CONFIG, RULES_CATALOG).niveis_categoria.energia).toBe(5);
  });
});

describe("regra 6.3 — % UC município secundário", () => {
  it("Floripa 35% UCs sem luz → DEFCON 4 em energia", () => {
    const s = emptySignals();
    s.celesc.municipios_secundarios = [
      { ibge_municipio: IBGE_FLORIANOPOLIS, municipio_nome: "Florianópolis", ucs_afetadas: 35000, ucs_total: 100000, pct: 35 },
    ];
    expect(computeDefcon(s, DEFAULT_CONFIG, RULES_CATALOG).niveis_categoria.energia).toBe(4);
  });

  it("Floripa 25% (abaixo do threshold 30%) → não dispara", () => {
    const s = emptySignals();
    s.celesc.municipios_secundarios = [
      { ibge_municipio: IBGE_FLORIANOPOLIS, municipio_nome: "Florianópolis", ucs_afetadas: 25000, ucs_total: 100000, pct: 25 },
    ];
    expect(computeDefcon(s, DEFAULT_CONFIG, RULES_CATALOG).niveis_categoria.energia).toBe(5);
  });

  it("ucs_total ausente (pct=null) → não dispara mesmo com muitas UCs", () => {
    const s = emptySignals();
    s.celesc.municipios_secundarios = [
      { ibge_municipio: IBGE_FLORIANOPOLIS, municipio_nome: "Florianópolis", ucs_afetadas: 50000, ucs_total: null, pct: null },
    ];
    expect(computeDefcon(s, DEFAULT_CONFIG, RULES_CATALOG).niveis_categoria.energia).toBe(5);
  });
});

describe("regras 6.2 vs 6.3 — prioridade", () => {
  it("se 6.2 dispara DEFCON 3 e 6.3 dispara DEFCON 4, vence 6.2 (prioridade menor + mais crítico)", () => {
    const config = configComLocalidades();
    const s = emptySignals();
    s.celesc.bairros_foco = [
      { label: "Casa", bairro_celesc: "Ipiranga", ibge_municipio: IBGE_SAO_JOSE, ucs_afetadas: 50 },
      { label: "Trabalho", bairro_celesc: "Furadinho", ibge_municipio: IBGE_PALHOCA, ucs_afetadas: 0 },
    ];
    s.celesc.municipios_secundarios = [
      { ibge_municipio: IBGE_FLORIANOPOLIS, municipio_nome: "Florianópolis", ucs_afetadas: 35000, ucs_total: 100000, pct: 35 },
    ];
    expect(computeDefcon(s, config, RULES_CATALOG).niveis_categoria.energia).toBe(3);
  });
});

describe("combineCategorias — agregação global = min", () => {
  it("min(2, 4, 5) = 2", () => {
    expect(combineCategorias({ energia: 2, clima: 4, mobilidade: 5 } as Record<"energia"|"clima"|"mobilidade", DefconLevel>)).toBe(2);
  });

  it("min(5, 5, 5) = 5", () => {
    expect(combineCategorias({ energia: 5, clima: 5, mobilidade: 5 } as Record<"energia"|"clima"|"mobilidade", DefconLevel>)).toBe(5);
  });

  it("uma categoria crítica puxa todo o estado", () => {
    expect(combineCategorias({ energia: 1, clima: 5, mobilidade: 5 } as Record<"energia"|"clima"|"mobilidade", DefconLevel>)).toBe(1);
  });
});

describe("hashSignals — determinismo", () => {
  it("mesmos sinais produzem mesmo hash", () => {
    expect(hashSignals(emptySignals())).toBe(hashSignals(emptySignals()));
  });

  it("hash ignora `agora`", () => {
    expect(hashSignals(emptySignals({ agora: 1 }))).toBe(hashSignals(emptySignals({ agora: 999 })));
  });

  it("mudar um sinal muda o hash", () => {
    const a = emptySignals();
    const b = emptySignals();
    b.defesa_civil.por_nivel.Alto = 1;
    expect(hashSignals(a)).not.toBe(hashSignals(b));
  });
});
