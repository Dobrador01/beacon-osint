import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import Parser from "rss-parser";
import ibgeDict from "./ibge_dict.json";

// Injetando estritamente a base real de 295 municípios de Santa Catarina compilada do arquivo fonte.
const IBGE_DICT = JSON.stringify(ibgeDict);

export const fetchWeatherOSINT = action({
  args: {},
  handler: async (ctx: any) => {
    const parser = new Parser();
    const feed = await parser.parseURL("https://www.defesacivil.sc.gov.br/categoria/aviso/feed/");
    
    // Process.env injection requirement
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    const responseSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        nivel_risco: {
          type: Type.STRING,
          description: "A classificação da gravidade deve ser estritamente escrita como: 'Baixo', 'Medio' ou 'Alto'",
        },
        cidades_afetadas_ibge: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description: "Lista de códigos numéricos IBGE de 7 dígitos afetados. Limite-se APENAS à chaves do nosso dicionário."
        },
        duracao_estimada_horas: {
          type: Type.INTEGER,
          description: "Tempo estimado em horas para a expiração do risco da ameaça (Inteiro positivo)."
        }
      }
    };

    const systemInstruction = `Você é o motor de extração de dados táticos do sistema Grid 48. Sua única função é ler o campo <description> de alertas da Defesa Civil de Santa Catarina via RSS e extrair os seguintes parâmetros:
1. Nível de Risco: Classifique o risco narrado APENAS como 'Baixo', 'Medio' ou 'Alto'.
2. Geolocalização (IBGE): Cruze o texto do alerta APENAS com as cidades deste dicionário JSON de monitoramento:
\${IBGE_DICT}
Retorne a lista contendo APENAS os Inteiros pertencentes ao Dicionário Base. Rejeite qualquer área exterior.
3. Duração (Horas): Retire ou aproxime. Se impreciso, use 24.
Não adicione limitantes de markdown, puro texto JSON de saida.`;

    for (const item of feed.items) {
      if (!item.guid || !item.description) continue;
      
      const conteudoHash = "hash_" + Buffer.from(item.guid + item.description).toString('base64').substring(0, 32);
      
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: `Texto Extraído do Alerta: ${item.description}`,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.1, // Extrema Determinação
          }
        });

        if (!response.text) continue;
        
        // Strip de Markdown silencioso da IA antes da conversão
        let rawJSON = response.text;
        rawJSON = rawJSON.replace(/```json/gi, "");
        rawJSON = rawJSON.replace(/```/g, "");
        rawJSON = rawJSON.trim();
        
        const payloadGemini = JSON.parse(rawJSON);

        // Bloqueio algébrico forçado para TS Math logic isolando A.I.
        const agora = Date.now();
        const horasEmMilissegundos = (payloadGemini.duracao_estimada_horas || 24) * 60 * 60 * 1000;
        const dataExpiracaoExata = Math.floor(agora + horasEmMilissegundos);

        await ctx.runMutation(internal.mutations.upsertAlerta, {
           guid: item.guid,
           titulo: item.title || "Sem título",
           link_oficial: item.link || "",
           data_publicacao: item.pubDate || new Date().toISOString(),
           nivel_risco: payloadGemini.nivel_risco || "Baixo",
           cidades_afetadas_ibge: payloadGemini.cidades_afetadas_ibge || [],
           expiresAt: dataExpiracaoExata,
           conteudo_hash: conteudoHash
        });

      } catch(e) {
        console.error(`Falha protetiva ativada no item ${item.guid}: `, e);
      }
    }
  }
});
