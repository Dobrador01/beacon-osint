/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as celesc_mutations from "../celesc/mutations.js";
import type * as celesc_queries from "../celesc/queries.js";
import type * as crons from "../crons.js";
import type * as defcon_actions from "../defcon/actions.js";
import type * as defcon_config from "../defcon/config.js";
import type * as defcon_dev from "../defcon/dev.js";
import type * as defcon_mutations from "../defcon/mutations.js";
import type * as defcon_queries from "../defcon/queries.js";
import type * as defcon_rules from "../defcon/rules.js";
import type * as defcon_rules_catalog from "../defcon/rules_catalog.js";
import type * as http from "../http.js";
import type * as ingestor from "../ingestor.js";
import type * as mock from "../mock.js";
import type * as mutations from "../mutations.js";
import type * as queries from "../queries.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actions: typeof actions;
  "celesc/mutations": typeof celesc_mutations;
  "celesc/queries": typeof celesc_queries;
  crons: typeof crons;
  "defcon/actions": typeof defcon_actions;
  "defcon/config": typeof defcon_config;
  "defcon/dev": typeof defcon_dev;
  "defcon/mutations": typeof defcon_mutations;
  "defcon/queries": typeof defcon_queries;
  "defcon/rules": typeof defcon_rules;
  "defcon/rules_catalog": typeof defcon_rules_catalog;
  http: typeof http;
  ingestor: typeof ingestor;
  mock: typeof mock;
  mutations: typeof mutations;
  queries: typeof queries;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
