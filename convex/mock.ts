import { mutation } from "./_generated/server";
import { internal } from "./_generated/api";

export const simularAmeaca = mutation({
  args: {},
  handler: async (ctx) => {
    // Injeção de Dados de Teste
    await ctx.runMutation(internal.mutations.upsertAlerta, {
      guid: "SIMULACAO-ALTO-" + Date.now(),
      titulo: "[SIMULAÇÃO] Ciclone Extratropical na Costa Leste",
      link_oficial: "https://defesacivil.sc.gov.br",
      data_publicacao: new Date().toISOString(),
      nivel_risco: "Alto",
      cidades_afetadas_ibge: [4205407, 4216602, 4209102, 4202404, 4202008, 4208906], // Floripa, Sao Jose, Joinville, Blumenau, Balneario, Criciuma
      expiresAt: Date.now() + (1000 * 60 * 60), // Expira em 1 hora
      conteudo_hash: "mock_hash_1_" + Date.now()
    });
    
    await ctx.runMutation(internal.mutations.upsertAlerta, {
      guid: "SIMULACAO-MEDIO-" + Date.now(),
      titulo: "[SIMULAÇÃO] Risco de Deslizamentos Localizados",
      link_oficial: "",
      data_publicacao: new Date().toISOString(),
      nivel_risco: "Medio",
      cidades_afetadas_ibge: [4204202, 4210100], // Chapecó e Itajaí
      expiresAt: Date.now() + (1000 * 60 * 60), 
      conteudo_hash: "mock_hash_2_" + Date.now()
    });
  }
});
