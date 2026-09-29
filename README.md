# Klaw

**Inteligencia comercial B2B con IA.** A partir de la URL de una empresa, Klaw extrae su sitio, infiere su Perfil de Cliente Ideal (ICP), propone empresas objetivo en una geografía y localiza a sus tomadores de decisión, transmitiendo cada paso en tiempo real.

```
URL ──► Scraper (httpx) ──► ICP (LLM) ──► Empresas objetivo (LLM) ──► Decisores (Hunter.io) ──► Tabla + CSV
                    └──────────── progreso en vivo vía Server-Sent Events ────────────┘
```

## Stack

| Capa | Tecnología |
|---|---|
| Backend | FastAPI · Pydantic v2 · pydantic-settings · httpx · BeautifulSoup/lxml |
| LLM | Anthropic (tool use → JSON garantizado) u OpenAI-compatible (`json_object`) |
| Enriquecimiento | Hunter.io Domain Search (emails con estado de verificación) |
| Frontend | Next.js 14 (App Router) · React 18 · TypeScript estricto · Tailwind CSS |
| Orquestación | Docker Compose |

## Inicio rápido

```bash
cp .env.example .env          # opcional: añade tus API keys
docker compose up --build
```

- Frontend: <http://localhost:3000>
- API + Swagger: <http://localhost:8000/docs>

**Sin API keys el sistema arranca en modo demo**: el ICP se infiere con heurísticas y los prospectos/contactos se marcan como `DEMO` (no se inventan personas ni emails). Añade `KLAW_ANTHROPIC_API_KEY` (u OpenAI) para prospectos reales y `KLAW_HUNTER_API_KEY` para decisores con email verificado.

### Desarrollo sin Docker

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
pytest

# Frontend (otra terminal)
cd frontend
npm install
npm run dev
```

## Estructura

```
klaw/
├── docker-compose.yml
├── .env.example
├── backend/
│   ├── app/
│   │   ├── main.py               # FastAPI: REST + SSE
│   │   ├── core/config.py        # Pydantic Settings (prefijo KLAW_)
│   │   ├── schemas/prospect.py   # ICPProfile, Company, DecisionMaker, ProspectResult, ScanEvent…
│   │   └── services/
│   │       ├── scraper.py        # Descarga asíncrona + limpieza HTML + protección SSRF
│   │       ├── ai_analyzer.py    # ICP y descubrimiento de prospectos vía LLM (+ modo demo)
│   │       ├── enricher.py       # Validación DNS + decisores (Hunter / Demo)
│   │       ├── jobs.py           # Gestor de jobs en memoria con pub/sub y replay
│   │       └── pipeline.py       # Orquestación del flujo completo
│   ├── tests/test_core.py
│   ├── requirements.txt
│   └── Dockerfile
└── frontend/
    ├── src/
    │   ├── app/page.tsx          # Dashboard
    │   ├── components/
    │   │   ├── UrlScanner.tsx    # URL + geografía + nº de prospectos
    │   │   ├── ProgressFeed.tsx  # Log en vivo + barra y etapas
    │   │   ├── IcpCard.tsx       # Resumen del ICP inferido
    │   │   └── ProspectTable.tsx # Filtros, orden, filas expandibles, exportación CSV
    │   ├── hooks/useScan.ts      # Máquina de estados del escaneo (fetch + EventSource)
    │   ├── lib/api.ts · lib/csv.ts
    │   └── types/index.ts        # Espejo tipado de los schemas del backend
    ├── package.json
    └── Dockerfile
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | Estado y modo (demo / proveedores activos) |
| `POST` | `/api/scan` | Crea un job. Body: `{ "url", "geography", "max_prospects" }` → `202 { job_id, stream_url }` |
| `GET` | `/api/scan/{job_id}` | Snapshot: estado, ICP y prospectos |
| `GET` | `/api/scan/{job_id}/stream` | SSE: eventos `log`, `icp`, `prospect`, `done`, `error` |

Cada evento SSE lleva `id` secuencial; si la conexión se corta, `EventSource` reconecta con `Last-Event-ID` y el backend reenvía solo lo pendiente.

```bash
curl -X POST localhost:8000/api/scan -H 'content-type: application/json' \
     -d '{"url":"https://acme.com","geography":"Jalisco","max_prospects":5}'
curl -N localhost:8000/api/scan/<job_id>/stream
```

## Variables de entorno

Ver `.env.example`. Principales:

| Variable | Default | Uso |
|---|---|---|
| `KLAW_LLM_PROVIDER` | `anthropic` | `anthropic` · `openai` · `none` |
| `KLAW_ANTHROPIC_API_KEY` / `KLAW_ANTHROPIC_MODEL` | — / `claude-sonnet-4-5` | Inferencia vía Anthropic |
| `KLAW_OPENAI_API_KEY` / `KLAW_OPENAI_BASE_URL` | — / OpenAI | Cualquier endpoint OpenAI-compatible |
| `KLAW_HUNTER_API_KEY` | — | Decisores y verificación de email |
| `KLAW_CORS_ORIGINS` | `http://localhost:3000` | Orígenes permitidos (coma) |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | URL del API vista por el navegador (build-time) |

## Decisiones de diseño

- **Salida estructurada garantizada.** Con Anthropic se fuerza `tool_choice` con el JSON Schema generado por Pydantic; toda respuesta se valida y, si falla, se reintenta una vez enviando los errores al modelo.
- **Sin datos inventados.** Los contactos solo provienen del proveedor; `email_verified` es `true` únicamente si Hunter reporta `valid`. Los dominios propuestos por el LLM se validan por DNS y se señalan si no resuelven.
- **SSRF.** El scraper rechaza hosts que resuelven a IPs no públicas, también tras redirecciones (`KLAW_SCRAPER_ALLOW_PRIVATE_HOSTS=true` solo para desarrollo).
- **Límites.** Timeout, tamaño máximo de descarga, concurrencia de enriquecimiento y TTL de jobs configurables.
- **CSV seguro.** BOM UTF-8 para Excel y neutralización de inyección de fórmulas.

## Hoja de ruta

- Persistencia de jobs y colas en Redis (habilita múltiples workers).
- Proveedores adicionales (Apollo, Clearbit) implementando `ContactProvider`.
- Renderizado con navegador headless para sitios SPA.
- Autenticación, multi-tenant y límites por plan.

## Cumplimiento

El uso de datos personales de contacto está sujeto a la LFPDPPP (México), GDPR (UE) y normas equivalentes. Verifique la base legal y los términos de su proveedor de datos antes de contactar a prospectos.
