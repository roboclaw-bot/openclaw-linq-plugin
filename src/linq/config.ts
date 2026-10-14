import { z } from "zod";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

const e164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/u, "expected E.164 phone number");
const publicWebhookUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith("https://"),
    "expected public HTTPS webhook URL",
  );
const webhookPathSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9/_-]+$/u, "expected dedicated webhook path");
const allowFromEntrySchema = z.union([z.string().min(1), z.number()]);
const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().min(1).default("default"),
    id: z.string().min(1),
  })
  .strict();

export const LinqAccountConfigSchema: z.ZodType<Record<string, unknown>> =
  z.lazy(() =>
    z
      .object({
        name: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        apiToken: z.union([z.string().min(1), secretRefSchema]).optional(),
        tokenFile: z.string().min(1).optional(),
        fromPhone: e164PhoneSchema.optional(),
        dmPolicy: z
          .enum(["pairing", "allowlist", "open", "disabled"])
          .default("pairing")
          .optional(),
        allowFrom: z.array(allowFromEntrySchema).optional(),
        inboundEnabled: z.boolean().optional(),
        webhookUrl: publicWebhookUrlSchema.optional(),
        webhookSecret: z.union([z.string().min(1), secretRefSchema]).optional(),
        webhookPath: webhookPathSchema.default("/linq-webhook").optional(),
        webhookHost: z.string().min(1).optional(),
        accounts: z.record(z.string(), LinqAccountConfigSchema).optional(),
        defaultAccount: z.string().min(1).optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        const tokenSources = [value.apiToken, value.tokenFile].filter(Boolean);
        if (tokenSources.length > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "configure only one of apiToken or tokenFile",
            path: ["apiToken"],
          });
        }
      }),
  );

export const LinqConfigSchema = LinqAccountConfigSchema;

const linqAccountJsonSchemaProperties = {
  enabled: { type: "boolean" },
  name: { type: "string", minLength: 1 },
  apiToken: {
    anyOf: [{ type: "string", minLength: 1 }, { $ref: "#/$defs/secretRef" }],
  },
  tokenFile: { type: "string", minLength: 1 },
  fromPhone: { type: "string", pattern: "^\\+[1-9]\\d{6,14}$" },
  dmPolicy: {
    enum: ["pairing", "allowlist", "open", "disabled"],
    default: "pairing",
  },
  allowFrom: {
    type: "array",
    items: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  inboundEnabled: { type: "boolean", default: true },
  webhookUrl: { type: "string", format: "uri", pattern: "^https://" },
  webhookSecret: {
    anyOf: [{ type: "string", minLength: 1 }, { $ref: "#/$defs/secretRef" }],
  },
  webhookPath: {
    type: "string",
    pattern: "^/[A-Za-z0-9/_-]+$",
    default: "/linq-webhook",
  },
  webhookHost: { type: "string", minLength: 1 },
  accounts: { type: "object", additionalProperties: { $ref: "#" } },
  defaultAccount: { type: "string", minLength: 1 },
};

export const LinqConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: linqAccountJsonSchemaProperties,
  not: { required: ["apiToken", "tokenFile"] },
  $defs: {
    secretRef: {
      type: "object",
      additionalProperties: false,
      required: ["source", "id"],
      properties: {
        source: { enum: ["env", "file", "exec"] },
        provider: { type: "string", default: "default" },
        id: { type: "string", minLength: 1 },
      },
    },
  },
};

export const LinqChannelConfigSchema = buildJsonChannelConfigSchema(
  LinqConfigJsonSchema,
  {
    cacheKey: "linq-channel-config",
    runtime: {
      safeParse: (value) => {
        const result = LinqConfigSchema.safeParse(value);
        if (result.success) {
          return { success: true, data: result.data };
        }
        return {
          success: false,
          issues: result.error.issues.map((issue) => ({
            path: issue.path.filter(
              (segment): segment is string | number =>
                typeof segment === "string" || typeof segment === "number",
            ),
            message: issue.message,
          })),
        };
      },
    },
  },
);
