# @esrs/frontend — ESRS portal

React 19 + Vite 8 + TypeScript + Tailwind CSS 4. The SPA talks to exactly one place:
`src/lib/apiClient.ts`, which understands the API envelope and the shared Zod schemas.

## Layout

```
src/
├── main.tsx              # QueryClient + StrictMode + BrowserRouter mount
├── App.tsx               # route table
├── api/queries.ts        # TanStack Query hooks (server state) + query key registry
├── components/           # Layout, Feedback (spinner/notice/error), Badge chips, Activity (thread + timeline)
├── lib/                  # config, apiClient, formatting helpers, cx
├── pages/                # DashboardPage, LifecyclePage, RequestActivityPage, SlaPoliciesPage, NotFoundPage
├── test/                 # setup.ts + harness.tsx (fetch stub, providers, fixtures)
├── env.d.ts              # typed import.meta.env
└── index.css             # Tailwind @theme tokens (status/priority/SLA palette)
```

## Commands

| Command                                        | Purpose                                           |
| ---------------------------------------------- | ------------------------------------------------- |
| `npm run dev:frontend`                         | Vite dev server on `http://localhost:5173`        |
| `npm run build --workspace @esrs/frontend`     | production bundle in `frontend/dist`              |
| `npm run preview:frontend`                     | serve the built bundle on `http://localhost:4173` |
| `npm run typecheck --workspace @esrs/frontend` | `tsc --noEmit` over `src` + configs               |
| `npm test --workspace @esrs/frontend`          | Vitest + React Testing Library in jsdom           |

`npm run dev` at the repository root starts the shared build, the API and this server together.

## Configuration

Copy `frontend/.env.example` to `frontend/.env.local` to override. Only `VITE_`-prefixed
variables reach the browser, and none of them is secret:

| Variable              | Default                 | Meaning                             |
| --------------------- | ----------------------- | ----------------------------------- |
| `VITE_API_BASE_URL`   | `/api/v1`               | base path the client calls          |
| `VITE_DEV_API_TARGET` | `http://localhost:4000` | where the dev proxy forwards `/api` |

The dev proxy ( `vite.config.ts` ) means the browser never makes a cross-origin request locally,
so no CORS configuration is needed during development. In production the SPA is served from the
same origin as the API, or `CORS_ORIGINS` on the backend is set to the real web origin.

## Conventions

- **Server state** lives in TanStack Query; components never call `fetch` directly.
- **Contract first**: badges, selects and the lifecycle explorer render values from
  `GET /api/v1/meta`; `@esrs/shared` is the offline fallback, so a rule can never be duplicated by
  hand into a component.
- **Errors are surfaced, not swallowed**: `ApiError` carries the code, HTTP status and
  `request_id`, and `ErrorNotice` shows them; 5xx messages are replaced by a generic sentence
  (`toUserMessage`).
- **Tailwind tokens**: colours come from `@theme` in `index.css`. Class strings that depend on a
  status/priority are written out in full (`Badge.tsx`) because Tailwind only generates utilities
  it can see statically.
- **User content is text, never markup**: comment bodies and timeline details reach React as children,
  so they are escaped on the way into the DOM. `dangerouslySetInnerHTML` is banned outright by
  `no-restricted-syntax` in the root ESLint config, which makes a raw-HTML render a lint failure rather
  than a review catch.
- **Tests** stub `fetch` per test (`src/test/harness.tsx`); no test requires a running backend.
