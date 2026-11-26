import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway((ctx) => {
  if (!ctx.isEnvironment("production") || ctx.projectId !== "f38167de-f48c-457f-972c-3bc0a48c6135" || ctx.environmentId !== "23ef5879-22be-4740-9d47-34984792631d") {
    throw new Error("Esta configuración corresponde únicamente a production de Xabor.");
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const branch = git("branch", "--show-current") || process.env.GITHUB_HEAD_REF;
  if (!branch) throw new Error("Selecciona una rama antes de planificar un despliegue.");
  const commitSha = git("rev-parse", "HEAD");
  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 1000 });
  const xaborAgent = service("xabor-agent", {
    source: github("MapolatoPN/xabor-agent", { branch, commitSha }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/health",
    healthcheckTimeout: 60,
    // ON_FAILURE es predeterminado. Lo dejamos implícito para que el plan
    // refleje la configuración que devuelve Railway después de aplicarla.
    deploy: { restartPolicyMaxRetries: 3 },
    configFile: "",
    preDeploy: "node scripts/predeploy-run-032-033.mjs",
    replicas: { "sfo": 1 },
    domains: ["www.xabor.mx", "xabor.mx"],
    env: { LEADS_NOTIFICATION_EMAIL: process.env.XABOR_LEADS_NOTIFICATION_EMAIL || preserve(), ADMIN_PASSWORD: preserve(), ANTHROPIC_API_KEY: preserve(), CLIP_API_KEY: preserve(), CLIP_API_SECRET: preserve(), DATABASE_URL: preserve(), DEEPGRAM_API_KEY: preserve(), ELEVENLABS_API_KEY: preserve(), ELEVENLABS_VOICE_ID: preserve(), FACTURAPI_KEY: preserve(), INTEGRATIONS_ENCRYPTION_KEY: preserve(), MARIO_TELEFONO: preserve(), MEDIA_MAX_IMAGE_MB: preserve(), MEDIA_SIGNED_URL_TTL_SECONDS: preserve(), MESERO_AGENTE_MODE: preserve(), MESERO_AGENTE_SHADOW: preserve(), MESERO_SHADOW_MODE: preserve(), META_APP_ID: preserve(), META_APP_SECRET: preserve(), META_CONFIG_ID: preserve(), META_PHONE_NUMBER_ID: preserve(), META_REDIRECT_URI: preserve(), META_VERIFY_TOKEN: preserve(), META_WHATSAPP_TOKEN: preserve(), MP_SAAS_ACCESS_TOKEN: preserve(), MP_SAAS_MODO: preserve(), MP_SAAS_VENDEDOR_ID: preserve(), MP_SAAS_WEBHOOK_SECRET: preserve(), NODE_ENV: preserve(), OTP_PROVEEDOR: preserve(), PANEL_PASSWORD: preserve(), PEDIDO_SHADOW_MODE: preserve(), PUBLIC_URL: preserve(), RAILPACK_INSTALL_CMD: preserve(), RAPPI_AUTH_URL: preserve(), RAPPI_BASE_URL: preserve(), RAPPI_CLIENT_ID: preserve(), RAPPI_CLIENT_SECRET: preserve(), RAPPI_COOKING_TIME: preserve(), RAPPI_NEW_BASE_URL: preserve(), RAPPI_STORE_ID: preserve(), RAPPI_WEBHOOK_SECRET: preserve(), RESEND_API_KEY: preserve(), S3_ACCESS_KEY_ID: preserve(), S3_BUCKET: preserve(), S3_ENDPOINT: preserve(), S3_FORCE_PATH_STYLE: preserve(), S3_REGION: preserve(), S3_SECRET_ACCESS_KEY: preserve(), SAT_CERT_BASE64: preserve(), SAT_KEY_BASE64: preserve(), SAT_KEY_PASSWORD: preserve(), SESSION_SECRET: preserve(), STORAGE_DRIVER: preserve(), STORAGE_ENV_PREFIX: preserve(), TWILIO_ACCOUNT_SID: preserve(), TWILIO_AUTH_TOKEN: preserve(), TWILIO_PHONE_NUMBER: preserve(), TWILIO_SMS_NUMBER: preserve(), VAPID_EMAIL: preserve(), VAPID_PRIVATE_KEY: preserve(), VAPID_PUBLIC_KEY: preserve(), WHATSAPP_ADMIN_NUMERO: preserve(), WHATSAPP_FLOW_ENDPOINT: preserve(), WHATSAPP_FLOW_PRIVATE_KEY: preserve(), WHATSAPP_INTERACTIVOS: preserve(), WHATSAPP_SOPORTE: preserve(), XABOR_ALTA_BASICO_EMAIL_PERMITIDO: preserve(), XABOR_ALTA_BASICO_MODO: preserve(), XABOR_ALTA_PUBLICA_BASICO: preserve(), XABOR_BASICO_MENSUALIDAD_MXN: preserve(), XABOR_CONCILIACION_AUTOMATICA: preserve(), XABOR_EDGE_SETUP_URL: preserve(), XABOR_MIGRAR_BASICO: preserve(), XABOR_PILOTO_COBRO_NEGOCIO_ID: preserve(), XABOR_PILOTO_COBRO_USUARIO_ID: preserve(), XABOR_SUSCRIPCIONES_MP: preserve() },
  });

  return project("honest-tenderness", {
    resources: [Postgres, xaborAgent, postgresVolume],
  });
});
