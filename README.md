# Klaw

Videos explicativos de pizarra generados con IA.

- Landing y vista previa: GitHub Pages (https://luismib7-eng.github.io/Klaw/), publicada por `.github/workflows/deploy.yml`.
- API: Vercel (`api/generate.ts`, `api/stripe-webhook.ts`).
- Base de datos: Supabase (`supabase/migrations/001_init.sql`).

## Estructura

| Carpeta | Contenido |
|---|---|
| `src/` | Landing, vista previa y planes (React + Vite) |
| `remotion/` | Motor de trazos `WhiteboardVideo` |
| `pipeline/` | Guion (storyboard), voz y sincronización, íconos |
| `saas/` | Planes, créditos y derechos por plan |
| `api/` | Funciones de Vercel |
| `server/lib/` | Utilidades del backend |
| `supabase/migrations/` | Esquema de base de datos |

## Comandos

```
npm install
npm run dev               # desarrollo local
npm run build             # build del frontend (dist/)
npm run typecheck:server  # chequeo de tipos del backend
```
