/**
 * POST /api/generate · Klaw
 *
 * Recibe un prompt, genera guion (Claude), voz con marcas de tiempo (ElevenLabs),
 * ilustraciones y sincronización, registra el trabajo en render_jobs y devuelve las
 * props listas para <WhiteboardVideo /> en Remotion Player.
 *
 * Seguridad y cobro:
 *  1. Exige un JWT válido de Supabase Auth y rol owner/editor en el workspace.
 *  2. Reserva créditos ANTES de llamar a cualquier API de pago (deduct_credits).
 *  3. Liquida lo realmente consumido al terminar, o reembolsa todo si algo falla
 *     (settle_credits es idempotente).
 *
 * Solicitud:
 *   Authorization: Bearer <access_token de Supabase>
 *   { "workspaceId": "uuid", "prompt": "texto", "title"?: "…", "voiceId"?: "…", "height"?: 480 | 720 | 1080 }
 */
import { z } from "zod";
import { buildStoryboard, type Storyboard } from "../pipeline/storyboard.js";
import { charsToWords, scheduleScene, synthesizeScene, type TimedPath, type Word } from "../pipeline/sync.js";
import { CREDIT_COST, EntitlementError, resolveRenderSettings, type Height, type PlanId } from "../saas/entitlements.js";
import { env } from "../server/lib/env.js";
import { errorResponse, HttpError, json, preflight } from "../server/lib/http.js";
import { putObject, signedUrl } from "../server/lib/storage.js";
import { admin, creditBalance, requireRole, requireUser } from "../server/lib/supabase.js";
import { resolveSceneAssets, VIEWBOX } from "../server/lib/visuals.js";

const FPS = 30;
const TTS_CONCURRENCY = 3; // ajustar al límite de concurrencia del plan de ElevenLabs

// Tope de la narración según el esquema del storyboard: 12 escenas × 320 caracteres.
const MAX_NARRATION_CHARS = 12 * 320;
const RESERVE_CREDITS = Math.ceil(MAX_NARRATION_CHARS / 1000) * CREDIT_COST.per1kTtsChars;

const Body = z.object({
  workspaceId: z.uuid(),
  prompt: z.string().trim().min(10, "El prompt debe tener al menos 10 caracteres.").max(4000),
  title: z.string().trim().min(1).max(80).optional(),
  voiceId: z.string().trim().min(1).max(64).optional(),
  height: z.union([z.literal(480), z.literal(720), z.literal(1080)]).default(720),
});

interface StoredScene {
  id: string;
  narration: string;
  audioKey: string;
  durationSec: number;
  words: Word[];
  paths: TimedPath[];
}

/** Ejecuta tareas asíncronas con un máximo de N en paralelo, preservando el orden. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function updateJob(jobId: string, patch: Record<string, unknown>) {
  const { error } = await admin().from("render_jobs").update(patch).eq("id", jobId);
  if (error) console.error("[klaw] no se pudo actualizar el job", jobId, error);
}

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function POST(request: Request): Promise<Response> {
  let jobId: string | null = null;
  let reserved = false;

  try {
    // 1) Identidad, datos de entrada y permisos
    const user = await requireUser(request);
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "INVALID_BODY", "Solicitud inválida.", z.flattenError(parsed.error));
    const input = parsed.data;
    await requireRole(input.workspaceId, user.id, ["owner", "editor"]);

    const db = admin();
    const { data: ws, error: wsError } = await db
      .from("workspaces")
      .select("id, plan, trial_ends_at")
      .eq("id", input.workspaceId)
      .single();
    if (wsError || !ws) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "El espacio de trabajo no existe.");
    const plan = ws.plan as PlanId;
    const trialEndsAt = ws.trial_ends_at ? new Date(ws.trial_ends_at as string) : undefined;

    // Validación temprana del plan (prueba vencida, resolución); la duración se valida al final.
    const preliminary = resolveRenderSettings({ plan, requestedHeight: input.height as Height, durationSec: 0, trialEndsAt });

    // 2) Proyecto y job
    const { data: project, error: projectError } = await db
      .from("projects")
      .insert({
        workspace_id: input.workspaceId,
        created_by: user.id,
        title: input.title ?? "Sin título",
        source_kind: "prompt",
        source_ref: input.prompt,
        voice_id: input.voiceId ?? null,
      })
      .select("id")
      .single();
    if (projectError || !project) throw projectError ?? new Error("No se pudo crear el proyecto");

    const { data: job, error: jobError } = await db
      .from("render_jobs")
      .insert({
        project_id: project.id,
        workspace_id: input.workspaceId,
        created_by: user.id,
        kind: "generate",
        status: "queued",
        height: preliminary.height,
        watermark: preliminary.watermark,
      })
      .select("id")
      .single();
    if (jobError || !job) throw jobError ?? new Error("No se pudo crear el render job");
    jobId = job.id as string;

    // 3) Reserva atómica de créditos antes de gastar en APIs externas
    const { data: ok, error: rpcError } = await db.rpc("deduct_credits", {
      p_workspace_id: input.workspaceId,
      p_amount: RESERVE_CREDITS,
      p_render_job_id: jobId,
    });
    if (rpcError) throw rpcError;
    if (!ok) {
      await updateJob(jobId, { status: "failed", error: "NO_CREDITS", finished_at: new Date().toISOString() });
      throw new HttpError(402, "NO_CREDITS", `Necesitas al menos ${RESERVE_CREDITS} créditos para generar un video.`);
    }
    reserved = true;

    // 4) Paso A: guion y storyboard (Claude + Zod)
    await updateJob(jobId, { status: "scripting", progress: 0.1, started_at: new Date().toISOString() });
    const storyboard: Storyboard = await buildStoryboard({ kind: "prompt", text: input.prompt });
    await db
      .from("projects")
      .update({ storyboard, title: input.title ?? storyboard.title, language: storyboard.language })
      .eq("id", project.id);

    // 5) Paso B: voz por escena con marcas de tiempo
    await updateJob(jobId, { status: "voicing", progress: 0.35 });
    const voiceId = input.voiceId ?? env("ELEVENLABS_DEFAULT_VOICE_ID");
    const scenes = storyboard.scenes;
    const voiced = await mapLimit(scenes, TTS_CONCURRENCY, (scene, i) =>
      synthesizeScene(scene.narration, voiceId, {
        previousText: scenes[i - 1]?.narration,
        nextText: scenes[i + 1]?.narration,
      }),
    );

    // 6) Pasos C y D: ilustraciones, sincronización y audio en R2
    await updateJob(jobId, { status: "syncing", progress: 0.7 });
    const warnings: string[] = [];
    const stored: StoredScene[] = await Promise.all(
      scenes.map(async (scene, i) => {
        const words = charsToWords(voiced[i].alignment);
        const assets = resolveSceneAssets(scene);
        const scheduled = scheduleScene(
          scene.beats.map((b) => ({ id: b.id, anchor: b.anchor })),
          assets,
          words,
        );
        warnings.push(...scheduled.warnings.map((w) => `[${scene.id}] ${w}`));
        const audioKey = `workspaces/${input.workspaceId}/projects/${project.id}/audio/${scene.id}.mp3`;
        await putObject(audioKey, voiced[i].audio, "audio/mpeg");
        return { id: scene.id, narration: scene.narration, audioKey, durationSec: scheduled.durationSec, words, paths: scheduled.paths };
      }),
    );

    const durationSec = stored.reduce((s, sc) => s + sc.durationSec, 0);
    const settings = resolveRenderSettings({ plan, requestedHeight: input.height as Height, durationSec, trialEndsAt });

    // 7) Persistencia del timeline (fuente única de verdad, RF-11)
    const timeline = { viewBox: `0 0 ${VIEWBOX.w} ${VIEWBOX.h}`, fps: FPS, scenes: stored };
    const { error: saveError } = await db
      .from("projects")
      .update({ timeline, duration_sec: Math.round(durationSec * 100) / 100 })
      .eq("id", project.id);
    if (saveError) throw saveError;

    // 8) Liquidación: se cobra solo la voz realmente sintetizada
    const ttsChars = scenes.reduce((s, sc) => s + sc.narration.length, 0);
    const actual = Math.ceil(ttsChars / 1000) * CREDIT_COST.per1kTtsChars;
    const { error: settleError } = await db.rpc("settle_credits", { p_render_job_id: jobId, p_actual: actual });
    if (settleError) throw settleError;
    reserved = false;

    await updateJob(jobId, { status: "done", progress: 1, finished_at: new Date().toISOString() });

    // 9) Props para <Player component={WhiteboardVideo} inputProps={props} />
    const props = {
      viewBox: timeline.viewBox,
      height: settings.height,
      watermark: settings.watermark,
      brandText: "Klaw",
      scenes: await Promise.all(
        stored.map(async (sc) => ({
          id: sc.id,
          audioSrc: await signedUrl(sc.audioKey),
          durationSec: sc.durationSec,
          paths: sc.paths,
        })),
      ),
    };

    return json(request, {
      projectId: project.id,
      jobId,
      fps: FPS,
      durationInFrames: props.scenes.reduce((s, sc) => s + Math.ceil(sc.durationSec * FPS), 0),
      props,
      captions: stored.map((sc) => ({ sceneId: sc.id, words: sc.words })),
      creditsCharged: actual,
      balance: await creditBalance(input.workspaceId),
      downgraded: settings.downgraded,
      warnings,
    });
  } catch (error) {
    if (jobId) {
      if (reserved) {
        const { error: refundError } = await admin().rpc("settle_credits", { p_render_job_id: jobId, p_actual: 0 });
        if (refundError) console.error("[klaw] reembolso fallido", jobId, refundError);
      }
      const message = error instanceof Error ? error.message : String(error);
      await updateJob(jobId, { status: "failed", error: message.slice(0, 500), finished_at: new Date().toISOString() });
    }
    if (error instanceof EntitlementError) {
      return errorResponse(request, new HttpError(402, error.code, error.message));
    }
    return errorResponse(request, error);
  }
}
