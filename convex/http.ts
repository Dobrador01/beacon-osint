import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// Validate the X-Grid48-GW-Key header against any of the configured PSKs.
//
// Rotation flow (zero-downtime):
//   1. Set PSK_GATEWAY_V2 alongside the existing PSK_GATEWAY. Gateway accepts
//      both — clients can migrate one at a time.
//   2. Update each client (engine, ESP32, etc.) to send the new key.
//   3. Once no traffic uses the old key, unset PSK_GATEWAY (or rename V2→main).
//
// `expectedKeyEnv` is kept as a parameter so a future "sensor" key namespace
// (PSK_SENSOR / PSK_SENSOR_V2) can reuse the same helper without code changes.
const validateAuth = (request: Request, expectedKeyEnv: string) => {
  const authHeader = request.headers.get("X-Grid48-GW-Key");
  if (!authHeader) return false;

  const accepted = [
    process.env[expectedKeyEnv],
    process.env[`${expectedKeyEnv}_V2`],
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  if (accepted.length === 0) {
    console.error(`[AUTH] No keys configured for ${expectedKeyEnv} or ${expectedKeyEnv}_V2`);
    return false;
  }

  return accepted.includes(authHeader);
};

// POST /gateway -> Recebe telemetria do ESP32 Gateway
http.route({
  path: "/gateway",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!validateAuth(request, "PSK_GATEWAY")) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const body = await request.json();
      await ctx.runMutation(internal.mutations.ingestTelemetry, body);
      return new Response("ACK", { status: 200 });
    } catch (e) {
      console.error("Error processing gateway POST:", e);
      return new Response("Bad Request", { status: 400 });
    }
  }),
});

// POST /sitrep-request -> ESP32 envia pedido de SITREP
http.route({
  path: "/sitrep-request",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!validateAuth(request, "PSK_GATEWAY")) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const body = await request.json();

      await ctx.runMutation(internal.mutations.createSitrepRequest, {
        request_id: body.request_id,
        categoria: body.categoria,
        localidade: body.localidade,
      });

      // The Gemini Action will compile the SITREP in the background
      ctx.runAction(internal.actions.processSitrep, {
        request_id: body.request_id,
        categoria: body.categoria,
        localidade: body.localidade,
      }).catch(e => console.error("[HTTP] Action execution failed", e));

      return new Response("ACK", { status: 200 });
    } catch (e) {
      return new Response("Bad Request", { status: 400 });
    }
  }),
});

// GET /sitrep-response?request_id=X -> ESP32 faz polling
http.route({
  path: "/sitrep-response",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!validateAuth(request, "PSK_GATEWAY")) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const requestId = url.searchParams.get("request_id");

    if (!requestId) {
      return new Response("Missing request_id", { status: 400 });
    }

    const result = await ctx.runQuery(internal.queries.getSitrepStatus, { request_id: requestId });

    if (!result) {
      return new Response("Not Found", { status: 404 });
    }

    if (result.status === "ready") {
      return new Response(JSON.stringify({
        status: "ready",
        resposta_valor: result.resposta_valor,
        ttl_seconds: result.ttl_seconds
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ status: result.status }), {
      status: 202, // Accepted but processing
      headers: { "Content-Type": "application/json" }
    });
  }),
});

export default http;
