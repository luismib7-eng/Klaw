/**
 * Almacenamiento en Cloudflare R2 (API compatible con S3), según el stack aprobado del PRD.
 * Los objetos son privados; el navegador recibe URLs firmadas de vida corta.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, envOr } from "./env.js";

let s3: S3Client | null = null;

function client(): S3Client {
  s3 ??= new S3Client({
    region: "auto",
    endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
  });
  return s3;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await client().send(new PutObjectCommand({ Bucket: env("R2_BUCKET"), Key: key, Body: body, ContentType: contentType }));
}

export async function signedUrl(key: string): Promise<string> {
  const expiresIn = Number(envOr("SIGNED_URL_TTL_SEC", "3600"));
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: env("R2_BUCKET"), Key: key }), { expiresIn });
}
